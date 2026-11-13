import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  getWorkerTurnGitHubGrant,
  assertWorkerTurnGitHubGrantCurrent,
  type WorkerTurnExecutionIdentityCapability,
} from "./placement-turn-claim-events.js";

/** Credential delivery retains the exact request owner through renewal and response publication. */
export async function refreshWorkerGitHubBinding(params: {
  identity: WorkerConnectionIdentity;
  generation?: number;
  source: WorkerTurnExecutionIdentityCapability | undefined;
  validate: () => boolean;
  isTerminal: () => boolean;
}) {
  const { identity, source } = params;
  const rejected = { ok: false as const, closeReason: "placement-mismatch" as const };
  if (!source) {
    return rejected;
  }
  const grant = getWorkerTurnGitHubGrant(identity);
  const assertCurrent = () => {
    if (!params.validate()) {
      throw new Error("Worker GitHub turn authority closed");
    }
    source.receiptAuthority();
    assertWorkerTurnGitHubGrantCurrent(identity, grant);
  };
  try {
    assertCurrent();
    const result = await source.run(() =>
      params.isTerminal() ? undefined : grant?.refresh(params.generation),
    );
    assertCurrent();
    return {
      ok: true as const,
      // A terminal ACK can land while renewal is in flight or before its response is consumed.
      get result() {
        return params.isTerminal() ? undefined : result;
      },
      assertCurrent,
    };
  } catch {
    return rejected;
  }
}
