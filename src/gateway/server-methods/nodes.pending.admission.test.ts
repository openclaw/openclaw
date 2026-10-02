import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { withDevicePairingLock } from "../../infra/device-pairing-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  current: vi.fn(),
  list: vi.fn(),
  ack: vi.fn(),
  drain: vi.fn(),
}));

vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.capture,
  isNodePairingGenerationCurrent: mocks.current,
}));
vi.mock("../node-runtime-state.js", () => ({
  listPendingNodeActions: mocks.list,
  acknowledgePendingNodeActions: mocks.ack,
  replacePendingNodeActionsForGeneration: vi.fn(),
}));
vi.mock("../node-pending-work.js", () => ({
  drainNodePendingWork: mocks.drain,
  enqueueNodePendingWork: vi.fn(),
  removeNodePendingWorkItem: vi.fn(),
}));
vi.mock("./nodes.wake-reconnect.js", () => ({ wakeNodeForReconnect: vi.fn() }));
vi.mock("./nodes.wake.js", () => ({ maybeSendNodeWakeNudge: vi.fn() }));

import { nodePendingWorkHandlers } from "./nodes.pending-work.js";
import { nodePendingActionHandlers } from "./nodes.pending.js";

const generation = { nodeId: "node", key: "generation" };
const requests = [
  { method: "node.pending.pull", params: {} },
  { method: "node.pending.ack", params: { ids: ["action"] } },
  { method: "node.pending.drain", params: { maxItems: 1 } },
] as const;
type Request = (typeof requests)[number];
type Session = { connId: string } | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue(generation);
  mocks.current.mockResolvedValue(true);
  mocks.list.mockReturnValue([]);
  mocks.ack.mockReturnValue([]);
  mocks.drain.mockReturnValue({ items: [], revision: 1 });
});

function dispatch(request: Request, lookup: () => Session, respond: (ok: boolean) => unknown) {
  const handler = expectDefined(
    nodePendingActionHandlers[request.method] ?? nodePendingWorkHandlers[request.method],
    request.method,
  );
  return handler({
    req: { type: "req", id: "pending", method: request.method },
    params: request.params,
    client: { connId: "caller", connect: { device: { id: "node" }, role: "node" } },
    context: {
      getRuntimeConfig: () => ({}),
      nodeRegistry: { getForPairingGeneration: lookup },
    },
    respond,
  } as never);
}

it.each(requests)("starts $method before its queued pairing observation", async (request) => {
  const readReady = createDeferredCore();
  const releaseRead = createDeferredCore();
  const writerReady = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const order: string[] = [];
  mocks.capture.mockImplementationOnce(async () => {
    readReady.resolve();
    await releaseRead.promise;
    return generation;
  });
  const respond = vi.fn((ok: boolean) => order.push(ok ? "response" : "error"));
  const running = dispatch(request, () => ({ connId: "caller" }), respond);
  let observation: Promise<void> | undefined;
  try {
    await readReady.promise;
    // The test's own context queues an independent writer, not a reentrant borrow.
    observation = withDevicePairingLock(async () => {
      order.push("observation");
      writerReady.resolve();
      await releaseWriter.promise;
    });
    releaseRead.resolve();
    await writerReady.promise;
    expect(order).toEqual(["response", "observation"]);
  } finally {
    releaseRead.resolve();
    releaseWriter.resolve();
    await Promise.allSettled([running, observation]);
  }
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(true);
});

it.each(requests)(
  "does not publish $method for a replaced same-generation session",
  async (request) => {
    let session = { connId: "caller" };
    let scheduled = false;
    const responses: Array<{ ok: boolean; connId: string }> = [];
    const lookup = () => {
      const admitted = session;
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          session = { connId: "replacement" };
        });
      }
      return admitted;
    };
    const respond = vi.fn((ok: boolean) => responses.push({ ok, connId: session.connId }));
    await dispatch(request, lookup, respond);
    expect(responses).toHaveLength(1);
    expect(responses.filter(({ ok, connId }) => ok && connId !== "caller")).toEqual([]);
  },
);

it.each(
  requests.flatMap((request) => ["invalidated", "replaced"].map((state) => ({ request, state }))),
)(
  "refuses $request.method for an already $state session without consuming work",
  async ({ request, state }) => {
    const respond = vi.fn();
    await dispatch(
      request,
      () => (state === "invalidated" ? undefined : { connId: "replacement" }),
      respond,
    );
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.ack).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  },
);
