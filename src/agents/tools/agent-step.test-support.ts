import { aroundAll, aroundEach, vi } from "vitest";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";

/** Join the real A2A continuations before their test-owned stores and mocks are released. */
export function observeSessionSendContinuations() {
  const spy = vi.spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkContinuation");
  const failures = new Map<Promise<unknown>, { reason: unknown; reported: boolean }>();

  function reportFailures(previous?: ReadonlySet<Promise<unknown>>): void {
    const pending: unknown[] = [];
    for (const [completion, failure] of failures) {
      if (!failure.reported && !previous?.has(completion)) {
        failure.reported = true;
        pending.push(failure.reason);
      }
    }
    if (pending.length === 1 && pending[0] instanceof Error) {
      throw pending[0];
    }
    if (pending.length > 0) {
      throw new AggregateError(pending, "sessions_send continuation cleanup failed");
    }
  }

  // Sequential after hooks stop on rejection. Report only after their owners have unwound.
  aroundEach((runTest) => {
    const previous = new Set(failures.keys());
    return runQaGatewayFixture(runTest, () => reportFailures(previous));
  });
  aroundAll((runSuite) => runQaGatewayFixture(runSuite, () => reportFailures()));

  return {
    async settle(): Promise<void> {
      // Retain history until restore: concurrent cleanup callers must join the same work.
      let joinedResults = 0;
      while (joinedResults < spy.mock.results.length) {
        const start = joinedResults;
        const batch = spy.mock.results.slice(start);
        joinedResults += batch.length;
        const completions = batch.flatMap((result, index) =>
          spy.mock.calls[start + index]?.[1] === "session:a2a-send" && result.type === "return"
            ? [result.value]
            : [],
        );
        const settled = await Promise.allSettled(completions);
        for (const [index, result] of settled.entries()) {
          const completion = completions[index]!;
          if (result.status === "rejected" && !failures.has(completion)) {
            failures.set(completion, { reason: result.reason, reported: false });
          }
        }
      }
    },
    restore() {
      spy.mockRestore();
    },
  };
}
