import {
  deriveSessionLifecycleSnapshot,
  resolveSessionLifecycleTerminal,
  derivePersistedSessionLifecyclePatch,
  type LifecycleEventLike,
} from "../config/sessions/session-run-lifecycle-projection.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry-state.js";
import { resolveSessionRunError } from "../sessions/session-run-error-format.js";

export function resolveLifecycleFailureSummary(event: LifecycleEventLike): string | undefined {
  const { terminal, status } = resolveSessionLifecycleTerminal(event);
  return terminal && status
    ? resolveSessionRunError({ ...terminal, errorKind: event.data?.errorKind }, status)
    : undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(
  params: Omit<Parameters<typeof deriveSessionLifecycleSnapshot>[0], "lastRunError">,
) {
  return deriveSessionLifecycleSnapshot({
    ...params,
    lastRunError: resolveLifecycleFailureSummary(params.event),
  });
}

export function deriveGatewaySessionLifecycleProjectionPatch(params: {
  entry?: Parameters<typeof derivePersistedSessionLifecyclePatch>[0]["entry"];
  event: LifecycleEventLike;
}): ReturnType<typeof deriveGatewaySessionLifecycleSnapshot> {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch({
    ...params,
    currentLifecycleGeneration: getAgentRunLifecycleGeneration(),
    lastRunError: resolveLifecycleFailureSummary(params.event),
  });
  return patch;
}
