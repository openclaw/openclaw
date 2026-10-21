// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreesGcResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGatewayConnectionLifecycle } from "../gateway-connection-lifecycle.ts";
import { gcManagedWorktrees } from "./gc-worktrees.ts";

function receipt(overrides: Partial<WorktreesGcResult> = {}): WorktreesGcResult {
  return {
    jobId: "cleanup-job",
    state: "completed",
    outcome: "completed",
    removed: [],
    orphansDeleted: 0,
    snapshotsPruned: 0,
    ...overrides,
  };
}

function setup() {
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request");
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  const timerCount = vi.getTimerCount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(timerCount).toBe(0);
});

it("enqueues once, polls the same job serially, and settles only when cleanup completes", async () => {
  const { request, run } = setup();
  const slowPoll = createDeferred<WorktreesGcResult>();
  const completed = receipt({ removed: ["retired"] });
  request
    .mockResolvedValueOnce(receipt({ state: "queued" }))
    .mockReturnValueOnce(slowPoll.promise)
    .mockResolvedValueOnce(completed);
  const settled = vi.fn();
  const pending = run().then(settled);
  await vi.advanceTimersByTimeAsync(999);
  expect(request.mock.calls).toEqual([["worktrees.gc", {}]]);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenLastCalledWith("worktrees.gc", { jobId: "cleanup-job" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(settled).not.toHaveBeenCalled();
  slowPoll.resolve(receipt({ state: "running" }));
  await vi.advanceTimersByTimeAsync(999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  expect(settled).toHaveBeenCalledExactlyOnceWith(completed);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith("worktrees.gc", { jobId: "cleanup-job" });
});

it.each([
  [receipt({ state: "failed", error: "cleanup owner stopped" }), "cleanup owner stopped"],
  [
    receipt({
      outcome: "partial",
      issues: [{ stage: "idle", outcome: "failed", reason: "repository unavailable" }],
    }),
    "repository unavailable",
  ],
] as const)("surfaces terminal error %s without starting another job", async (result, message) => {
  const { request, run } = setup();
  request.mockResolvedValueOnce(receipt({ state: "queued" })).mockResolvedValueOnce(result);
  const failed = expect(run()).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(1_000);
  await failed;
  expect(request).toHaveBeenCalledTimes(2);
});

it("does not turn a queued response without a job ID into another enqueue", async () => {
  const { request, run } = setup();
  request.mockResolvedValueOnce(receipt({ state: "queued", jobId: undefined }));
  await expect(run()).rejects.toThrow("cleanup failed");
  expect(request).toHaveBeenCalledOnce();
});

it.each(["before enqueue", "during enqueue", "between polls", "during poll"] as const)(
  "retires the old Gateway epoch after a same-client reconnect %s",
  async (phase) => {
    const { request, run, reconnect } = setup();
    const response = createDeferred<WorktreesGcResult>();
    if (phase === "before enqueue") {
      reconnect();
    }
    if (phase === "during enqueue") {
      request.mockReturnValueOnce(response.promise);
    } else {
      request
        .mockResolvedValueOnce(receipt({ state: "queued" }))
        .mockReturnValueOnce(response.promise);
    }
    const pending = run();
    await vi.advanceTimersByTimeAsync(phase === "during poll" ? 1_000 : 0);
    if (phase !== "before enqueue") {
      reconnect();
    }
    response.resolve(receipt({ state: "failed", error: "old Gateway failure" }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(
      phase === "before enqueue" ? 0 : phase === "during poll" ? 2 : 1,
    );
  },
);
