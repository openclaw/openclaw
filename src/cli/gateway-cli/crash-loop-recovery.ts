import {
  inspectGatewayCrashLoopBreakerAsync,
  recordGatewayCrashLoopRecovery,
} from "../../infra/gateway-boot-lifecycle.js";

export function createGatewayCrashLoopRecovery(params: {
  bootId: string | undefined;
  getActiveBootId: () => string | undefined;
  onRecovered: (bootId: string) => void;
}): (signal?: AbortSignal) => Promise<number | undefined> {
  return async (signal) => {
    const suppressedBootId = params.bootId;
    const assertBootCurrent = () => {
      if (!suppressedBootId || params.getActiveBootId() !== suppressedBootId) {
        throw new Error("Gateway crash-loop recovery belongs to a replaced boot");
      }
    };
    const assertCurrent = () => {
      signal?.throwIfAborted();
      assertBootCurrent();
    };
    assertCurrent();
    const decision = await inspectGatewayCrashLoopBreakerAsync(process.env, Date.now(), signal);
    assertCurrent();
    if (decision.recoveryPausedUntilMs !== undefined) {
      return decision.recoveryPausedUntilMs;
    }
    if (!decision.recovered || decision.uncleanBoots !== 0) {
      throw new Error("Gateway crash-loop recovery has no cleared breaker window");
    }
    const recoveredBootId = await recordGatewayCrashLoopRecovery(
      suppressedBootId,
      process.env,
      undefined,
      assertCurrent,
    );
    assertBootCurrent();
    if (!recoveredBootId) {
      throw new Error("Gateway crash-loop recovery did not commit");
    }
    // Adopt a committed boot identity even if close overtook the worker's reply.
    params.onRecovered(recoveredBootId);
    return undefined;
  };
}
