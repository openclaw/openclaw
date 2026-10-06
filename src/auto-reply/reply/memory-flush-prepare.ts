import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import type { MemoryFlushToolRunContext } from "../../agents/agent-tools.memory-flush.types.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  delegateMemoryAudience,
  type MemoryAudienceGrant,
  resolveMemoryAudienceFromEntry,
} from "../../plugins/memory-audience.js";
import { getMemoryProviderRuntime } from "../../plugins/memory-state.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { resolveModelFallbackOptions } from "./agent-runner-utils.js";
import { isToolsMemoryFlushPlan, resolveMemoryFlushPlanForRun } from "./memory-flush-plan.js";
import {
  deriveMemoryFlushId,
  ensureMemoryFlushTargetFile,
  prepareMemoryFlushSession,
} from "./memory-flush-session.js";
import type { FollowupRun } from "./queue.js";

const log = createSubsystemLogger("auto-reply/memory-flush");

// A flush-specific model is exact: it never inherits the source fallback chain.
function resolveMemoryFlushModelFallbackOptions(
  run: FollowupRun["run"],
  model: string | undefined,
  config: FollowupRun["run"]["config"],
) {
  const options = resolveModelFallbackOptions(run, config);
  const override = normalizeOptionalString(model);
  if (!override) {
    return options;
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim();
    if (overrideProvider && overrideModel) {
      return {
        ...options,
        provider: overrideProvider,
        model: overrideModel,
        requestedRouteResolution: "raw" as const,
        fallbacksOverride: [],
      };
    }
  }
  return {
    ...options,
    model: override,
    requestedRouteResolution: "raw" as const,
    fallbacksOverride: [],
  };
}

export async function prepareMemoryFlushAttempt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  preflightAdmission?: UserTurnTranscriptAdmissionReceipt;
  flushRunId: string;
  contextWindowTokens: number;
  memoryFlushWritable: boolean;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  recordPersistenceToolSuccess: () => void;
}) {
  params.assertCurrent();
  const resolution = resolveMemoryFlushPlanForRun({
    cfg: params.cfg,
    nowMs: Date.now(),
    contextWindowTokens: params.contextWindowTokens,
  });
  if (!resolution) {
    return null;
  }
  const plan = resolution.plan;
  if (!isToolsMemoryFlushPlan(plan) && !params.memoryFlushWritable) {
    return null;
  }
  const { sessionKey, sessionEntry, followupRun } = params;
  if (!sessionKey || !sessionEntry) {
    throw new Error("Memory flush has no current transcript target.");
  }
  const agentId = followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg);
  const sourceStorePath = resolveSessionStorePathForScope(
    { agentId, sessionKey, storePath: params.storePath },
    params.cfg,
  );
  // Only a native provider consumes audiences; other tool-plan owners resolve none.
  const sourceAudience =
    isToolsMemoryFlushPlan(plan) && getMemoryProviderRuntime()
      ? await resolveMemoryAudienceFromEntry(
          {
            agentId,
            sessionKey,
            sessionId: sessionEntry.sessionId,
            // Maintenance copies carry the source turn's owner status apart from their own grant.
            senderIsOwner: followupRun.memoryAudienceSenderIsOwner ?? followupRun.run.senderIsOwner,
            storePath: sourceStorePath,
            assertCallerCurrent: params.assertCurrent,
          },
          sessionEntry,
        )
      : undefined;
  if (sourceAudience?.status === "denied") {
    log.debug("memory flush skipped: source turn has no memory audience", {
      event: "memory_flush_no_audience",
      sourceSessionKey: sessionKey,
      sourceSessionId: sessionEntry.sessionId,
      pluginId: resolution.pluginId,
      reason: sourceAudience.reason,
    });
    return null;
  }
  // The caller releases both grants once the flush run settles; a preparation
  // failure before that hand-off releases them here.
  let delegated: MemoryAudienceGrant | undefined;
  const release = () => {
    delegated?.release();
    sourceAudience?.release();
  };
  try {
    // The detached transcript keeps maintenance messages out of the source session.
    params.assertCurrent();
    const memorySession = await prepareMemoryFlushSession({
      admission: params.preflightAdmission,
      source: {
        agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath: sourceStorePath,
      },
      runId: params.flushRunId,
      workspaceDir: followupRun.run.workspaceDir,
      signal: params.abortSignal,
    });
    if (!isToolsMemoryFlushPlan(plan)) {
      await ensureMemoryFlushTargetFile({
        workspaceDir: followupRun.run.workspaceDir,
        relativePath: plan.relativePath,
        assertCurrent: params.assertCurrent,
      });
    }
    const systemPrompt = [followupRun.run.extraSystemPrompt, plan.systemPrompt]
      .filter(Boolean)
      .join("\n\n");
    const selection = resolveMemoryFlushModelFallbackOptions(
      followupRun.run,
      plan.model,
      params.cfg,
    );
    // Delegation shares source revocation while binding tool use to the detached session.
    params.assertCurrent();
    delegated = sourceAudience
      ? await delegateMemoryAudience(sourceAudience.audience, {
          sessionKey: memorySession.sessionKey,
          storePath: memorySession.sessionTarget.storePath,
          detached: true,
          assertCallerCurrent: params.assertCurrent,
        })
      : undefined;
    const memoryFlushTools: MemoryFlushToolRunContext | undefined = isToolsMemoryFlushPlan(plan)
      ? {
          flushId: deriveMemoryFlushId({
            sourceSessionId: sessionEntry.sessionId,
            sourceLifecycleRevision: sessionEntry.lifecycleRevision,
            compactionCount: sessionEntry.compactionCount ?? 0,
          }),
          ownerPluginId: resolution.pluginId,
          persistenceToolNames: plan.persistenceToolNames,
          lookupToolNames: plan.lookupToolNames,
          recordPersistenceToolSuccess: params.recordPersistenceToolSuccess,
        }
      : undefined;
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      params.cfg,
      params.flushRunId,
      followupRun.run.agentId,
      "auto-reply.memory-flush",
      undefined,
      followupRun.operatorAuthority,
    );
    return {
      plan,
      writePath: isToolsMemoryFlushPlan(plan) ? undefined : plan.relativePath,
      systemPrompt,
      selection,
      preparedRunAdmission,
      memorySession,
      memoryAudience: delegated?.audience,
      memoryFlushTools,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
