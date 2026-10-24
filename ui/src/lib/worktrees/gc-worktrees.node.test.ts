// @vitest-environment node
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { WorktreesGcResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { WorktreesModel } from "../../pages/worktrees/worktrees-model.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { GatewayPageBinding } from "../gateway-page-binding.ts";

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
  const request = createGatewayRequestMock();
  for (const response of responses) {
    request.mockReturnValueOnce(Promise.resolve(response));
  }
  const list = vi.fn(async () => ({ worktrees: [] }));
  const client = createTestGatewayClient((...args) => {
    if (args[0] === "worktrees.gc") {
      return request(...args);
    }
    if (args[0] === "worktrees.list") {
      return list();
    }
    throw new Error(`Unexpected worktrees method: ${args[0]}`);
  });
  const source = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    hello: gatewayHelloForMethods(["worktrees.list", "worktrees.gc"]),
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  const context = { gateway: source.gateway } as ApplicationContext;
  let retireBeforeEnqueue = false;
  const reconnect = () => {
    source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
    source.publish({ ...source.gateway.snapshot, phase: "connected" });
  };
  const model = new WorktreesModel(
    () => context,
    () => {
      if (retireBeforeEnqueue && model.operation === "gc") {
        retireBeforeEnqueue = false;
        reconnect();
      }
    },
  );
  const binding = new GatewayPageBinding(() => undefined, {
    getGateway: () => source.gateway,
    invalidateRequests: () => model.invalidateRequests(),
  });
  model.gateway = Object.assign(binding, { readEpoch: () => binding.epoch });
  binding.connect();
  onTestFinished(() => binding.dispose());
  return {
    request,
    list,
    model,
    run: () => model.gc(),
    reconnect,
    retireBeforeEnqueue: () => {
      retireBeforeEnqueue = true;
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
  const { request, list, model, run } = setup(queued, slowPoll.promise, completed);
  const settled = vi.fn();
  const pending = run().then(settled);
  expect(model).toMatchObject({ operation: "gc", loading: true });
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
  expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith("worktrees.gc", { jobId: "cleanup-job" });
  expect(model).toMatchObject({ operation: null, loading: false, error: null });
  expect(list).toHaveBeenCalledOnce();
});

it.each([
  ["owner stopped", [queued, failed]],
  ["offline", [queued, partial]],
  ["cleanup failed", [{ ...queued, jobId: undefined }]],
] as const)("reports %s without starting another job", async (message, responses) => {
  const { request, model, run } = setup(...responses);
  const pending = run();
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(model).toMatchObject({ error: message, operation: null, loading: false });
  expect(request).toHaveBeenCalledTimes(responses.length);
});

it.each(["before enqueue", "during enqueue", "between polls", "during poll"] as const)(
  "ignores the old Gateway epoch %s",
  async (phase) => {
    const response = createDeferred<WorktreesGcResult>();
    const { request, list, model, run, reconnect, retireBeforeEnqueue } = setup(
      ...(phase === "during enqueue" ? [response.promise] : [queued, response.promise]),
    );
    if (phase === "before enqueue") {
      retireBeforeEnqueue();
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
    expect(model).toMatchObject({ error: null, operation: null, loading: false });
    expect(list).not.toHaveBeenCalled();
  },
);
