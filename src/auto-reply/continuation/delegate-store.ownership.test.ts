import { afterEach, describe, expect, it, vi } from "vitest";
import { listTaskFlowsForOwnerKey } from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { decodeDelegateFlow } from "./delegate-flow-store.js";
import { enqueuePendingDelegate, failQueuedDelegatesOwnedByRun } from "./delegate-store.js";

describe("delegate cancellation ownership", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetTaskFlowRegistryForTests({ persist: false });
  });

  it("cancels only the originating run and unambiguous legacy rows across reload", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-delegate-ownership-" },
      async () => {
        resetTaskFlowRegistryForTests({ persist: false });
        vi.useFakeTimers();
        const runStartedAt = Date.parse("2026-09-07T13:00:00.000Z");
        vi.setSystemTime(runStartedAt);
        const sessionKey = "agent:main:delegate-ownership";
        enqueuePendingDelegate(sessionKey, {
          task: "owned delegate",
          originRunId: "cancelled-run",
        });
        enqueuePendingDelegate(sessionKey, {
          task: "other attempt delegate",
          originRunId: "other-run",
        });
        enqueuePendingDelegate(sessionKey, { task: "ambiguous same-timestamp legacy delegate" });
        await vi.advanceTimersByTimeAsync(1);
        enqueuePendingDelegate(sessionKey, { task: "newer legacy delegate" });

        expect(
          failQueuedDelegatesOwnedByRun(
            sessionKey,
            { originRunId: "cancelled-run", legacyCreatedAfter: runStartedAt },
            "cancelled attempt",
          ),
        ).toBe(2);

        const assertOwnership = () => {
          const byTask = new Map(
            listTaskFlowsForOwnerKey(sessionKey).map((flow) => [
              decodeDelegateFlow(flow)?.task,
              flow,
            ]),
          );
          expect(byTask.get("owned delegate")).toMatchObject({ status: "failed" });
          expect(byTask.get("other attempt delegate")).toMatchObject({ status: "queued" });
          expect(byTask.get("ambiguous same-timestamp legacy delegate")).toMatchObject({
            status: "queued",
          });
          expect(byTask.get("newer legacy delegate")).toMatchObject({ status: "failed" });
        };
        assertOwnership();

        resetTaskFlowRegistryForTests({ persist: false });
        assertOwnership();
      },
    );
  });
});
