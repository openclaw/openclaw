import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import type { ModelRef } from "../../agents/model-selection.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { SessionEntry } from "../../config/sessions.js";
import { publishTranscriptUpdate } from "../../config/sessions/session-accessor.sqlite-events.js";
import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.sqlite-transcript-reports.js";
import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import { withSessionTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import {
  persistSessionPatchModelSelection,
  refreshSessionPatchQueuedSelection,
} from "./sessions-patch-model-selection.js";
import type { GroupAdmissionResult } from "./sessions-patch-types.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

/** Record the committed selection before another patch or prompt enters the mutation lane. */
export async function applySessionPatchModelEffects(
  params: Parameters<typeof refreshSessionPatchQueuedSelection>[0] & {
    previousModel?: ModelRef;
    storePath: string;
    env?: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  },
): Promise<void> {
  refreshSessionPatchQueuedSelection(params);
  const previous = params.previousModel;
  if (!previous) {
    return;
  }
  const next = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  if (previous.provider === next.provider && previous.model === next.model) {
    return;
  }
  const label = (model: ModelRef) =>
    params.catalog?.find((entry) => entry.provider === model.provider && entry.id === model.model)
      ?.name || `${model.provider}/${model.model}`;
  const details = { from: label(previous), to: label(next) };
  if (details.from === details.to) {
    details.from = `${previous.provider}/${previous.model}`;
    details.to = `${next.provider}/${next.model}`;
  }
  const scope = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    storePath: params.storePath,
    env: params.env,
  };
  try {
    await withSessionTranscriptWriteAssertion(scope, params.assertCurrent, async () => {
      const result = await appendSessionTranscriptReport(scope, {
        kind: "custom",
        customTypes: ["session-model-change"],
        selectReport: () => ({
          customType: "session-model-change",
          content: `Model changed from ${details.from} to ${details.to}.`,
          display: true,
          excludeFromContext: true,
          details,
        }),
      });
      if (!result.ok) {
        sessionLog.warn(
          `Model changed, but its history notice was not saved: ${result.error.code}`,
        );
        return;
      }
      await publishTranscriptUpdate(scope);
    });
  } catch (error) {
    // Selection already committed; a notice failure must not report a model rollback.
    sessionLog.warn(
      `Model changed, but its history notice could not be updated: ${formatErrorMessage(error)}`,
    );
  }
}

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  diagnostics?: SessionPatchDiagnostics;
  targets: Array<{
    accessChanged: boolean;
    entry: SessionEntry;
    target: {
      canonicalKey: string;
      fullPatch: SessionsPatchParams;
      requestedAgentId?: string;
      targetAgentId: string;
    };
  }>;
}): Promise<boolean> {
  const archivedSessionKeys = new Set<string>();
  for (const { target, entry, accessChanged } of params.targets) {
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistSessionPatchModelSelection({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(
      params.context,
      {
        sessionKey: target.canonicalKey,
        ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
        reason: "patch",
        ...(target.fullPatch.model !== undefined || target.fullPatch.agentRuntime !== undefined
          ? { catalogChanged: true }
          : {}),
      },
      { accessChanged },
    );
    if (typeof target.fullPatch.archived === "boolean") {
      params.context.sessionActivitySummaries?.handleLifecycle({
        sessionKey: target.canonicalKey,
        agentId: target.targetAgentId,
        reason: target.fullPatch.archived ? "archive" : "unarchive",
      });
    }
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  if (params.callerCanManageCron && archivedSessionKeys.size > 0) {
    const timing = params.diagnostics?.scope("cronEffects");
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg: params.cfg,
        sessionKeys: [...archivedSessionKeys],
      });
      for (const [sessionKey, disabledJobIds] of disabledBySession) {
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    } finally {
      timing?.finish();
    }
  }
  return archivedSessionKeys.size > 0;
}

/** Only applied assignments may repair the catalog; detached and status-model no-ops cannot. */
export function createSessionPatchCategoryRegistration(params: {
  patch: { category?: SessionsPatchParams["category"] };
  context: GatewayRequestContext;
}) {
  const category = params.patch.category;
  return async (result: GroupAdmissionResult, source: SessionEntryCommitContext): Promise<void> => {
    if (
      typeof category === "string" &&
      result.kind === "complete" &&
      result.outcomes.some(
        (outcome) => outcome.ok && outcome.applied && outcome.entry.category === category.trim(),
      )
    ) {
      await registerCommittedSessionCategory(category, params.context, source);
    }
  };
}
