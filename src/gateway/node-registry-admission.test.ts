import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

function createAdmittedNode() {
  const binding = { identity: "owned-identity", generation: "owned-generation" };
  const lookupEntered = createDeferred();
  const releaseLookup = createDeferred();
  const writerEntered = createDeferred();
  const releaseWriter = createDeferred();
  const operations: Promise<unknown>[] = [];
  let publicationAvailable = true;
  const lookup = vi.fn(() =>
    withDevicePairingLock(async () => {
      lookupEntered.resolve();
      await releaseLookup.promise;
      return binding;
    }),
  );
  const registry = new NodeRegistry({
    resolveCurrentPairingState: lookup,
    isPairingStateCurrent: (_nodeId, expected) => {
      // A following observation temporarily fences effects without changing
      // this node's identity or generation.
      if (!publicationAvailable) {
        throw new Error("pairing publication is pending");
      }
      return expected.identity === binding.identity && expected.generation === binding.generation;
    },
  });
  const frames: string[] = [];
  registerNodeSession(
    registry,
    makeClient("owned-connection", "owned-node", frames, { commands: ["debug.ping"] }),
    { pairingIdentity: binding.identity, pairingGeneration: binding.generation },
  );
  const dispose = async () => {
    releaseLookup.resolve();
    releaseWriter.resolve();
    registry.unregister("owned-connection");
    await Promise.allSettled(operations);
    // A bounded caller can finish before its queued admission callback runs.
    await withDevicePairingLock(async () => {});
  };
  onTestFinished(dispose);
  return {
    registry,
    frames,
    lookup,
    dispose,
    lookupEntered: lookupEntered.promise,
    writerEntered: writerEntered.promise,
    releaseLookup: () => releaseLookup.resolve(),
    releaseWriter: () => releaseWriter.resolve(),
    track<T>(operation: Promise<T>): Promise<T> {
      operations.push(operation);
      return operation;
    },
    queueObservation() {
      const operation = withDevicePairingLock(async () => {
        publicationAvailable = false;
        writerEntered.resolve();
        try {
          await releaseWriter.promise;
        } finally {
          publicationAvailable = true;
        }
      });
      operations.push(operation);
      return operation;
    },
  };
}

it.each(["list", "get"] as const)(
  "retains the admitted connected-node projection before a queued observation (%s)",
  async (operation) => {
    const node = createAdmittedNode();
    const reading = node.track(
      operation === "list"
        ? node.registry.listCurrentConnected()
        : node.registry.getCurrentConnected("owned-node").then((value) => (value ? [value] : [])),
    );
    await node.lookupEntered;
    void node.queueObservation();
    node.releaseLookup();
    expect((await reading).map((value) => value.nodeId)).toEqual(["owned-node"]);
  },
);

it("admits the next observation while the dispatched node response is still pending", async () => {
  const node = createAdmittedNode();
  const dispatched = createDeferred();
  const invocation = node.track(
    node.registry.invokeLifecycle({
      nodeId: "owned-node",
      expectedConnId: "owned-connection",
      expectedPairingGeneration: "owned-generation",
      command: "debug.ping",
      timeoutMs: 1_000,
      isDispatchAuthorized: () => true,
      onDispatchReady: () => dispatched.resolve(),
    }),
  );
  await node.lookupEntered;
  const writer = node.queueObservation();
  node.releaseLookup();
  expect(
    await Promise.race([dispatched.promise.then(() => true), invocation.then(() => false)]),
  ).toBe(true);
  expect(node.frames).toHaveLength(1);
  const request = JSON.parse(node.frames[0]!) as { payload: { id: string } };
  await node.writerEntered;
  node.releaseWriter();
  await writer;
  expect(
    node.registry.handleInvokeResult({
      id: request.payload.id,
      nodeId: "owned-node",
      connId: "owned-connection",
      ok: true,
      payloadJSON: '{"reply":"ready"}',
    }),
  ).toBe(true);
  await expect(invocation).resolves.toMatchObject({ ok: true, payloadJSON: '{"reply":"ready"}' });
});

it.each(["deadline", "abort"] as const)(
  "settles a queued invoke on %s without a late pairing lookup or send",
  async (closed) => {
    vi.useFakeTimers();
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const node = createAdmittedNode();
    const controller = new AbortController();
    onTestFinished(async () => {
      controller.abort();
      await node.dispose();
      clock.mockRestore();
      vi.useRealTimers();
    });
    const writer = node.queueObservation();
    await node.writerEntered;
    const onDispatchReady = vi.fn();
    const invocation = node.track(
      node.registry.invokeLifecycle({
        nodeId: "owned-node",
        expectedConnId: "owned-connection",
        expectedPairingGeneration: "owned-generation",
        command: "debug.ping",
        timeoutMs: 100,
        signal: controller.signal,
        isDispatchAuthorized: () => true,
        onDispatchReady,
      }),
    );
    if (closed === "deadline") {
      now = 1_100;
      await vi.advanceTimersByTimeAsync(100);
    } else {
      controller.abort();
    }
    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: { code: closed === "deadline" ? "TIMEOUT" : "ABORTED" },
    });
    expect(node.lookup).not.toHaveBeenCalled();
    expect(node.frames).toEqual([]);

    node.releaseLookup();
    node.releaseWriter();
    await writer;
    await withDevicePairingLock(async () => {});
    expect(node.lookup).not.toHaveBeenCalled();
    expect(node.frames).toEqual([]);
    expect(onDispatchReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps the dispatched result when its callback advances past the admission deadline", async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const node = createAdmittedNode();
  onTestFinished(async () => {
    await node.dispose();
    clock.mockRestore();
    vi.useRealTimers();
  });
  const onDispatchReady = vi.fn((id: string) => {
    expect(
      node.registry.handleInvokeResult({
        id,
        nodeId: "owned-node",
        connId: "owned-connection",
        ok: true,
        payloadJSON: '{"reply":"delivered"}',
      }),
    ).toBe(true);
    now = 1_101;
  });
  const invocation = node.track(
    node.registry.invokeLifecycle({
      nodeId: "owned-node",
      expectedConnId: "owned-connection",
      expectedPairingGeneration: "owned-generation",
      command: "debug.ping",
      timeoutMs: 100,
      isDispatchAuthorized: () => true,
      onDispatchReady,
    }),
  );
  await node.lookupEntered;
  node.releaseLookup();
  await expect(invocation).resolves.toMatchObject({
    ok: true,
    payloadJSON: '{"reply":"delivered"}',
  });
  expect(node.frames).toHaveLength(1);
  expect(onDispatchReady).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { label: "an Error", failure: new Error("dispatch callback failed") },
  { label: "undefined", failure: undefined },
])("preserves a dispatch callback throwing $label after send", async ({ failure }) => {
  const node = createAdmittedNode();
  const invocation = node.track(
    node.registry.invokeLifecycle({
      nodeId: "owned-node",
      expectedConnId: "owned-connection",
      expectedPairingGeneration: "owned-generation",
      command: "debug.ping",
      timeoutMs: 0,
      isDispatchAuthorized: () => true,
      onDispatchReady: () => {
        // oxlint-disable-next-line typescript/only-throw-error -- Preserve JavaScript callback throws, including undefined.
        throw failure;
      },
    }),
  );
  const rejected = expect(invocation).rejects.toBe(failure);
  await node.lookupEntered;
  node.releaseLookup();
  await rejected;
  expect(node.frames).toHaveLength(1);
});
