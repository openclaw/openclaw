import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { recordSessionCreated } from "../../../sessions/session-created.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { recordSubagentSpawned } from "../../../sessions/session-state-events.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

/** Record setup now; requester participation is credited only after accepted dispatch. */
export async function recordSubagentSessionSetup(params: {
  cfg: OpenClawConfig;
  childEntry?: SessionEntry;
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  promptedAt: number;
}): Promise<() => void> {
  if (params.childEntry) {
    await recordSessionCreated(params.cfg, {
      sessionKey: params.childSessionKey,
      agentId: params.targetAgentId,
      entry: params.childEntry,
      spawned: { runId: params.childRunId, requesterSessionKey: params.requesterSessionKey },
    });
  } else {
    await recordSubagentSpawned({
      childSessionKey: params.childSessionKey,
      childRunId: params.childRunId,
      requesterSessionKey: params.requesterSessionKey,
      agentId: params.targetAgentId,
    });
  }
  return () => {
    void recordSessionParticipantBestEffort({
      promptedAt: params.promptedAt,
      identity: { type: "agent", id: params.requesterAgentId },
      agentId: params.targetAgentId,
      sessionKey: params.childSessionKey,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
        agentId: params.targetAgentId,
      }),
    });
  };
}

export function createSubagentSpawnLifecycleEmitter(params: {
  hookRunner: SubagentLifecycleHookRunner | null;
  childSessionKey: string;
  childSessionOrigin?: DeliveryContext;
  requesterInternalKey: string;
  progressOrigin: DeliveryContext & {
    channelId?: string;
    messageId?: string | number;
  };
  targetAgentId: string;
  label?: string;
  requesterOrigin?: DeliveryContext;
  requestThreadBinding: boolean;
  spawnMode: SpawnSubagentMode;
  resolvedModelMetadata: {
    resolvedModel?: string;
    resolvedProvider?: string;
  };
}): {
  spawned: (hookRunId: string) => Promise<void>;
  failed: (hookRunId: string) => Promise<boolean>;
} {
  const hookContext = (runId: string) => ({
    runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterInternalKey,
  });
  // "spawned"/"started" hooks mean an accepted Gateway run. Direct runs emit
  // after the shared pipeline; queued collectors emit from the scheduler start.
  return {
    async spawned(hookRunId) {
      if (params.hookRunner?.hasHooks("subagent_progress")) {
        try {
          await params.hookRunner.runSubagentProgress(
            {
              phase: "started",
              runId: hookRunId,
              childSessionKey: params.childSessionKey,
              requester: params.progressOrigin,
            },
            hookContext(hookRunId),
          );
        } catch {
          // Presentation hooks are best-effort after durable registration.
        }
      }
      if (params.hookRunner?.hasHooks("subagent_spawned")) {
        try {
          await params.hookRunner.runSubagentSpawned(
            {
              runId: hookRunId,
              childSessionKey: params.childSessionKey,
              agentId: params.targetAgentId,
              label: params.label,
              requester: {
                channel: params.requesterOrigin?.channel,
                accountId: params.requesterOrigin?.accountId,
                to: params.requesterOrigin?.to,
                threadId: params.requesterOrigin?.threadId,
              },
              threadRequested: params.requestThreadBinding,
              mode: params.spawnMode,
              ...params.resolvedModelMetadata,
            },
            hookContext(hookRunId),
          );
        } catch {
          // Spawn stays accepted if lifecycle presentation fails.
        }
      }
    },
    async failed(hookRunId) {
      if (!params.hookRunner?.hasHooks("subagent_ended")) {
        return false;
      }
      try {
        await params.hookRunner.runSubagentEnded(
          {
            targetSessionKey: params.childSessionKey,
            targetKind: "subagent",
            reason: "spawn-failed",
            sendFarewell: true,
            accountId: params.childSessionOrigin?.accountId,
            runId: hookRunId,
            outcome: "error",
            error: "Session failed to start",
          },
          hookContext(hookRunId),
        );
        return true;
      } catch {
        // Deletion remains responsible for the ended hook if presentation fails.
        return false;
      }
    },
  };
}
