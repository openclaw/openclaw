import type { SessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerLiveTrajectoryTarget } from "./live-event-projection.js";
import { resolveWorkerSessionTarget } from "./session-target.js";

export type WorkerLiveSessionBinding = Readonly<{
  environmentId: string;
  runEpoch: number;
  sessionId: string;
}>;

export type BoundLiveSession = WorkerLiveSessionBinding & { target: WorkerLiveTrajectoryTarget };

export function isValidLiveSessionBinding(binding: WorkerLiveSessionBinding): boolean {
  return (
    binding.environmentId.length > 0 &&
    binding.sessionId.length > 0 &&
    Number.isSafeInteger(binding.runEpoch) &&
    binding.runEpoch >= 0
  );
}

export function prepareBoundLiveSessionSafely(
  config: OpenClawConfig,
  binding: WorkerLiveSessionBinding,
): BoundLiveSession | undefined {
  try {
    if (!isValidLiveSessionBinding(binding)) {
      return undefined;
    }
    const target = resolveWorkerSessionTarget(config, binding.sessionId);
    return target
      ? {
          ...binding,
          target: {
            ...(target.agentId ? { agentId: target.agentId } : {}),
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
          },
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function matchesSessionIdentityMutation(
  binding: WorkerLiveSessionBinding,
  prepared: BoundLiveSession | undefined,
  mutation: SessionIdentityMutation,
): boolean {
  const targets =
    "current" in mutation ? [mutation.previous, mutation.current] : [mutation.previous];
  return targets.some(
    (target) =>
      target.sessionId === binding.sessionId ||
      (prepared ? target.sessionKeys.includes(prepared.target.sessionKey) : false),
  );
}
