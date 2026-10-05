import type { WorkerProtocolCloseReason } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerConnectionIdentity } from "./admission.js";
import {
  getWorkerTurnGitHubGrant,
  assertWorkerTurnGitHubGrantCurrent,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";

export async function refreshWorkerGitHubBinding(params: {
  identity: WorkerConnectionIdentity;
  generation?: number;
  source?: WorkerTurnExecutionIdentityCapability;
  isTerminal: () => boolean;
  validate: () =>
    | { ok: true }
    | { ok: false; closeReason: WorkerProtocolCloseReason }
    | { ok: false; reason: "epoch-mismatch" | "session-not-attached" };
}) {
  const { identity, generation, source, isTerminal, validate } = params;
  if (!source) {
    return { ok: false as const, closeReason: "placement-mismatch" as const };
  }
  const grant = getWorkerTurnGitHubGrant(identity);
  const admitted = validate();
  if (!admitted.ok) {
    return admitted;
  }
  const snapshot = await source.run(() =>
    isTerminal() ? undefined : grant?.refresh?.(generation),
  );
  const current = validate();
  if (!current.ok) {
    return current;
  }
  return {
    ok: true as const,
    get result() {
      return isTerminal() ? undefined : snapshot;
    },
    assertCurrent: () => assertWorkerTurnGitHubGrantCurrent(identity, grant),
  };
}
