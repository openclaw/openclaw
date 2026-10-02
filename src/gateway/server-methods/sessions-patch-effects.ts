import type {
  SessionAutomationPauseResult,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import type {
  GroupAdmissionResult,
  MutationOutcome,
  MutationTarget,
} from "./sessions-patch-types.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  hasCurrentCronAuthority: () => boolean;
  targets: Array<{
    outcome: Extract<MutationOutcome, { ok: true }>;
    assertCurrent: MutationTarget["commitGuard"];
    target: {
      canonicalKey: string;
      fullPatch: SessionsPatchParams;
      requestedAgentId?: string;
      targetAgentId: string;
    };
  }>;
}): Promise<void> {
  const automationPause = new Map<string, SessionAutomationPauseResult>();
  const archivedSessionKeys = new Set<string>();
  for (const {
    target,
    outcome: { entry, accessChanged },
  } of params.targets) {
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

  if (!params.callerCanManageCron) {
    for (const sessionKey of archivedSessionKeys) {
      automationPause.set(sessionKey, { status: "skipped", reason: "requires-admin" });
    }
  } else if (archivedSessionKeys.size > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg: params.cfg,
        sessionKeys: [...archivedSessionKeys],
        assertSessionCurrent: (sessionKey) => {
          if (!params.hasCurrentCronAuthority()) {
            throw new Error("Cron management authority changed");
          }
          for (const { target, assertCurrent } of params.targets) {
            if (target.canonicalKey === sessionKey && target.fullPatch.archived === true) {
              const error = assertCurrent();
              if (error) {
                throw new Error(error.message);
              }
            }
          }
        },
      });
      for (const [sessionKey, { disabledJobIds, failures }] of disabledBySession) {
        automationPause.set(
          sessionKey,
          failures.length > 0
            ? {
                status: "partial",
                pausedCount: disabledJobIds.length,
                failedCount: failures.length,
              }
            : { status: "complete", pausedCount: disabledJobIds.length, failedCount: 0 },
        );
        for (const { jobId, error } of failures) {
          sessionLog.warn(
            `sessions.patch: failed to disable cron job ${jobId} bound to archived session ${sessionKey}: ${formatErrorMessage(error)}`,
          );
        }
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      for (const sessionKey of archivedSessionKeys) {
        automationPause.set(sessionKey, { status: "failed", reason: "unavailable" });
      }
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    }
  }
  for (const { target, outcome } of params.targets) {
    const paused = automationPause.get(target.canonicalKey);
    if (target.fullPatch.archived === true && paused) {
      outcome.automationPause = paused;
    }
  }
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
