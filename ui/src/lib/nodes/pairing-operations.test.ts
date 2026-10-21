import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import {
  approveDevicePairing,
  approveNodePairingRequest,
  createInitialDevicesState,
  loadDevices,
  loadNodes,
  rejectDevicePairing,
  rejectNodePairingRequest,
} from "./page-operations.ts";

const deviceActions = [
  { method: "device.pair.approve", run: approveDevicePairing, failed: false },
  { method: "device.pair.reject", run: rejectDevicePairing, failed: true },
] as const;
const nodeActions = [
  { method: "node.pair.approve", run: approveNodePairingRequest, failed: false },
  { method: "node.pair.reject", run: rejectNodePairingRequest, failed: true },
] as const;

function setup(...replies: Promise<unknown>[]) {
  const request = vi.fn();
  for (const reply of replies) {
    request.mockReturnValueOnce(reply);
  }
  const state = createInitialDevicesState({ client: { request }, connected: true });
  return { request, state };
}

function settle(
  mutation: ReturnType<typeof deferred<unknown>>,
  failed: boolean,
  message = "pairing denied",
) {
  if (failed) {
    mutation.reject(new Error(message));
  } else {
    mutation.resolve({});
  }
}

it.each(deviceActions)("$method refresh/error", async ({ method, run, failed }) => {
  const mutation = deferred<unknown>();
  const refresh = deferred<unknown>();
  const { request, state } = setup(mutation.promise, refresh.promise);
  state.devicesError = "previous error";
  const settled = vi.fn();
  const pending = run(state, "request-1").then(settled);
  expect(request.mock.calls).toEqual([[method, { requestId: "request-1" }]]);
  expect(state.devicesError).toBe("previous error");
  settle(mutation, failed);
  if (failed) {
    await pending;
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.devicesError).toBe("pairing denied");
    return;
  }
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]).toEqual(["device.pair.list", {}]);
  expect(settled).not.toHaveBeenCalled();
  expect(state.devicesError).toBeNull();
  const devices = { pending: [], paired: [{ deviceId: "device-1" }] };
  refresh.resolve(devices);
  await pending;
  expect(state.devicesList).toEqual(devices);
  expect(state.devicesLoading).toBe(false);
});

it.each(["client", "generation", "disconnect"] as const)(
  "fences stale results: %s",
  async (transition) => {
    for (const failed of [false, true]) {
      const mutation = deferred<unknown>();
      const { request, state } = setup();
      request.mockReturnValue(mutation.promise);
      const replacement = vi.fn();
      state.devicesError = "current error";
      const pending = approveDevicePairing(state, "request-1");
      if (transition === "client") {
        state.client = { request: replacement };
      } else if (transition === "generation") {
        state.requestGeneration += 1;
      } else {
        state.connected = false;
      }
      settle(mutation, failed, "stale error");
      await pending;
      expect(request.mock.calls).toEqual([["device.pair.approve", { requestId: "request-1" }]]);
      expect(replacement).not.toHaveBeenCalled();
      expect(state.devicesError).toBe("current error");
      expect(state.devicesList).toBeNull();
    }
  },
);

it.each(nodeActions)("$method awaits both refreshes", async ({ method, run, failed }) => {
  const mutation = deferred<unknown>();
  const devices = deferred<unknown>();
  const nodes = deferred<unknown>();
  const { request: original, state } = setup(mutation.promise);
  const current = vi.fn().mockReturnValueOnce(devices.promise).mockReturnValueOnce(nodes.promise);
  state.devicesError = "previous device error";
  state.lastError = "previous node error";
  const settled = vi.fn();
  const pending = run(state, "request-1").then(settled);
  state.client = { request: current };
  state.requestGeneration += 1;
  settle(mutation, failed);
  await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(2));
  expect(original.mock.calls).toEqual([[method, { requestId: "request-1" }]]);
  expect(current.mock.calls).toEqual([
    ["device.pair.list", {}],
    ["node.list", {}],
  ]);
  expect(state.devicesError).toBe(failed ? "previous device error" : null);
  expect(state.lastError).toBe(failed ? "previous node error" : null);
  nodes.resolve({ nodes: [{ id: "node-1" }] });
  await vi.waitFor(() => expect(state.nodesLoading).toBe(false));
  expect(settled).not.toHaveBeenCalled();
  expect(state.devicesLoading).toBe(true);
  expect(state.devicesError).toBe(failed ? "previous device error" : null);
  devices.resolve({ pending: [], paired: [] });
  await pending;
  expect(state.nodes).toEqual([{ id: "node-1" }]);
  expect(state.devicesList).toEqual({ pending: [], paired: [] });
  expect(state.devicesError).toBe(failed ? "pairing denied" : null);
  expect(state.lastError).toBe(failed ? "previous node error" : null);
});

it("records node failure while an existing inventory load queues its quiet refresh", async () => {
  const devices = deferred<unknown>();
  const nodes = deferred<unknown>();
  const mutation = deferred<unknown>();
  const { request, state } = setup(devices.promise, nodes.promise, mutation.promise);
  request.mockResolvedValue({ pending: [], paired: [], nodes: [] });
  const initialLoad = Promise.all([loadDevices(state), loadNodes(state)]);
  const pending = rejectNodePairingRequest(state, "request-1");
  mutation.reject(new Error("pairing denied"));
  await pending;
  expect(request.mock.calls).toEqual([
    ["device.pair.list", {}],
    ["node.list", {}],
    ["node.pair.reject", { requestId: "request-1" }],
  ]);
  expect(state.devicesLoading).toBe(true);
  expect(state.nodesLoading).toBe(true);
  expect(state.devicesQueuedRefresh).toBe("quiet");
  expect(state.nodesQueuedRefresh).toBe("quiet");
  expect(state.devicesError).toBe("pairing denied");
  devices.resolve({ pending: [], paired: [] });
  nodes.resolve({ nodes: [] });
  await initialLoad;
  expect(request).toHaveBeenCalledTimes(5);
  expect(state.devicesQueuedRefresh).toBe("none");
  expect(state.nodesQueuedRefresh).toBe("none");
  expect(state.devicesError).toBe("pairing denied");
});

it.each([deviceActions[0], nodeActions[0]])("$method: offline", async ({ run }) => {
  const request = vi.fn();
  await run(createInitialDevicesState({ connected: true }), "request-1");
  await run(createInitialDevicesState({ client: { request }, connected: false }), "request-1");
  expect(request).not.toHaveBeenCalled();
});
