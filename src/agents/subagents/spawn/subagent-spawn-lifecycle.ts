import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

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
