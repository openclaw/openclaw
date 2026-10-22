// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { WorktreesGcResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { gcManagedWorktrees } from "./gc-worktrees.ts";

const completed: WorktreesGcResult = {
  jobId: "cleanup-job",
  state: "completed",
  outcome: "completed",
  removed: ["retired"],
  orphansDeleted: 0,
  snapshotsPruned: 0,
};
const queued: WorktreesGcResult = { ...completed, state: "queued", removed: [] };
const failed: WorktreesGcResult = { ...completed, state: "failed", error: "owner stopped" };
const issue = { stage: "idle", outcome: "failed", reason: "offline" } as const;
const partial: WorktreesGcResult = { ...completed, outcome: "partial", issues: [issue] };

function setup(...responses: (WorktreesGcResult | Promise<WorktreesGcResult>)[]) {
  vi.useFakeTimers();
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request");
  for (const response of responses) {
    request.mockReturnValueOnce(Promise.resolve(response));
  }
  const lifecycle = createGatewayConnectionLifecycle({ client, phase: "connected" });
  const scope = lifecycle.capture()!;
  return {
    request,
    run: () => gcManagedWorktrees(client, () => lifecycle.isCurrent(scope)),
    reconnect: () => {
      lifecycle.transition({ client, phase: "reconnecting" });
      lifecycle.transition({ client, phase: "connected" });
    },
  };
}

afterEach(() => {
  const timerCount = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(timerCount).toBe(0);
});

it("enqueues once, polls the same job serially, and settles only when cleanup completes", async () => {
  const slowPoll = createDeferred<WorktreesGcResult>();
  const { request, run } = setup(queued, slowPoll.promise, completed);
  const settled = vi.fn();
  const pending = run().then(settled);
  await vi.advanceTimersByTimeAsync(999);
  expect([request.mock.calls, settled.mock.calls]).toEqual([[["worktrees.gc", {}]], []]);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenLastCalledWith("worktrees.gc", { jobId: "cleanup-job" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect([request.mock.calls.length, settled.mock.calls]).toEqual([2, []]);
  slowPoll.resolve({ ...queued, state: "running" });
  await vi.advanceTimersByTimeAsync(999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(settled).toHaveBeenCalledExactlyOnceWith(completed);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith("worktrees.gc", { jobId: "cleanup-job" });
});

it.each([
  ["owner stopped", [queued, failed]],
  ["offline", [queued, partial]],
  ["cleanup failed", [{ ...queued, jobId: undefined }]],
] as const)("rejects %s without starting another job", async (message, responses) => {
  const { request, run } = setup(...responses);
  const rejection = expect(run()).rejects.toThrow(message);
  await Promise.all([vi.advanceTimersByTimeAsync(1_000), rejection]);
  expect(request).toHaveBeenCalledTimes(responses.length);
});

it.each(["before enqueue", "during enqueue", "between polls", "during poll"] as const)(
  "ignores the old Gateway epoch %s",
  async (phase) => {
    const response = createDeferred<WorktreesGcResult>();
    const { request, run, reconnect } = setup(
      ...(phase === "during enqueue" ? [response.promise] : [queued, response.promise]),
    );
    if (phase === "before enqueue") {
      reconnect();
    }
    const pending = run();
    await vi.advanceTimersByTimeAsync(phase === "during poll" ? 1_000 : 0);
    if (phase !== "before enqueue") {
      reconnect();
    }
    response.resolve(failed);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(
      phase === "before enqueue" ? 0 : phase === "during poll" ? 2 : 1,
    );
  },
);
