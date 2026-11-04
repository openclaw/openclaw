import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
import type { MemoryFlushToolRunContext } from "../../agents/agent-tools.memory-flush.types.js";
import { filterToolsByMessageProvider } from "../../agents/agent-tools.message-provider-policy.js";
import { prepareConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { projectConversationToolNames } from "../../agents/conversation-tool-policy-pipeline.js";
import type { SandboxToolPolicy } from "../../agents/sandbox/types.js";
import { createSessionMaintenanceFollowup } from "../../agents/session-maintenance/run.js";
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
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { buildEmbeddedRunContext, resolveModelFallbackOptions } from "./agent-runner-utils.js";
import {
  isToolsMemoryFlushPlan,
  type MemoryFlushPlanForRunResolution,
} from "./memory-flush-plan.js";
import {
  deriveMemoryFlushId,
  ensureMemoryFlushTargetFile,
  prepareMemoryFlushSession,
} from "./memory-flush-session.js";
import type { FollowupRun } from "./queue.js";

const log = createSubsystemLogger("auto-reply/memory-flush");

export async function prepareMemoryFlushAttempt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  preflightAdmission?: UserTurnTranscriptAdmissionReceipt;
  recoveryContextTokenBudget?: number;
  sandboxToolPolicy?: SandboxToolPolicy;
  flushRunId: string;
  resolution: MemoryFlushPlanForRunResolution;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  recordPersistenceToolSuccess: () => void;
}) {
  params.assertCurrent();
  const { resolution } = params;
  const { plan } = resolution;
  const { sessionKey, sessionEntry, followupRun } = params;
  if (!sessionKey || !sessionEntry) {
    throw new Error("Memory flush has no current transcript target.");
  }
  const agentId = followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg);
  const selection = resolveModelFallbackOptions(followupRun.run, params.cfg);
  const sourcePolicySessionKey =
    params.runtimePolicySessionKey ?? followupRun.run.runtimePolicySessionKey ?? sessionKey;
  const maintenanceRun = createSessionMaintenanceFollowup({
    run: followupRun.run,
    sessionEntry,
    cfg: params.cfg,
    sessionKey,
    runtimePolicySessionKey: sourcePolicySessionKey,
    provider: selection.provider,
    model: selection.model,
    auth: followupRun.run,
  }).run;
  if (isToolsMemoryFlushPlan(plan)) {
    const context = buildEmbeddedRunContext({
      run: maintenanceRun,
      sessionCtx: {},
      hasRepliedRef: undefined,
    });
    const capabilityProfile = await prepareConversationCapabilityProfile({
      ...context,
      config: params.cfg,
      sessionKey: sourcePolicySessionKey,
      // Provider-specific policy belongs to the selected fallback attempt.
      sandboxToolPolicy: params.sandboxToolPolicy,
      operatorAuthority: followupRun.operatorAuthority,
      pluginMetadataSnapshot: await resolvePluginMetadataSnapshotAsync({
        config: params.cfg,
        workspaceDir: maintenanceRun.workspaceDir,
      }),
    });
    const permitted = projectConversationToolNames({
      capabilityProfile,
      toolNames: filterToolsByMessageProvider(
        plan.persistenceToolNames.map((name) => ({ name })),
        context.messageProvider,
      ).map((tool) => tool.name),
      toolMeta: () => ({ pluginId: resolution.pluginId }),
      warn: () => {},
    });
    if (!permitted.some((name) => name !== "read")) {
      log.debug("memory flush skipped: no declared persistence tool survived policy", {
        event: "memory_flush_tools_unavailable",
        sourceSessionKey: sessionKey,
        pluginId: resolution.pluginId,
      });
      return null;
    }
  }
  params.assertCurrent();
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
            resolveAgentStorePath: (hopAgentId) =>
              resolveSessionStorePathForScope({ agentId: hopAgentId }, params.cfg),
            assertCallerCurrent: params.assertCurrent,
          },
          sessionEntry,
        )
      : undefined;
  // The source turn's own attempt resolves the same lineage and owns the operator warning.
  if (sourceAudience?.status === "denied") {
    log.debug("memory flush skipped: source turn has no memory audience", {
      event: "memory_flush_no_audience",
      sourceSessionKey: sessionKey,
      sourceSessionId: sessionEntry.sessionId,
      pluginId: resolution.pluginId,
      kind: sourceAudience.kind,
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
    maintenanceRun.sessionId = memorySession.sessionId;
    maintenanceRun.sessionKey = memorySession.sessionKey;
    maintenanceRun.sessionFile = memorySession.sessionFile;
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
      writePath: isToolsMemoryFlushPlan(plan) ? undefined : plan.relativePath,
      systemPrompt,
      selection,
      preparedRunAdmission,
      memorySession: {
        ...memorySession,
        ...(params.recoveryContextTokenBudget !== undefined
          ? { disableCompactionRecovery: true as const }
          : {}),
      },
      memoryAudience: delegated?.audience,
      memoryFlushTools,
      maintenanceRun,
      sourcePolicySessionKey,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
