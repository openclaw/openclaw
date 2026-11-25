import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import * as pairing from "./page-operations.ts";
const actions = [
  ["device.pair.approve", pairing.approveDevicePairing, false, false],
  ["device.pair.reject", pairing.rejectDevicePairing, false, true],
  ["node.pair.approve", pairing.approveNodePairingRequest, true, false],
  ["node.pair.reject", pairing.rejectNodePairingRequest, true, true],
] as const;
const transitions = ["client", "generation", "disconnect"] as const;
const nodeList = { nodes: [{ id: "node-1" }] };
const deviceList = { pending: [], paired: [{ deviceId: "device-1" }] };
const errors = { devicesError: "device error", lastError: "node error" };
function setup(order: Array<"mutation" | "devices" | "nodes"> = ["mutation"]) {
  const replies = {
    mutation: deferred<unknown>(),
    devices: deferred<unknown>(),
    nodes: deferred<unknown>(),
  };
  const request = vi.fn();
  order.forEach((name) => request.mockReturnValueOnce(replies[name].promise));
  const state = pairing.createInitialDevicesState({ client: { request }, connected: true });
  const settled = vi.fn();
  const start = (run: typeof pairing.approveDevicePairing) => run(state, "request-1").then(settled);
  return { ...replies, request, state, settled, start };
}
function settle(mutation: ReturnType<typeof deferred<unknown>>, error?: string) {
  return error ? mutation.reject(new Error(error)) : mutation.resolve({});
}
it("keeps a replacement decision guarded when a retired request settles", async () => {
  const { mutation, devices, request, state } = setup(["mutation", "devices"]);
  request.mockResolvedValue({ pending: [], paired: [] });
  const first = pairing.approveDevicePairing(state, "request-1");
  state.requestGeneration += 1;
  state.devicesDeciding = [];
  const second = pairing.approveDevicePairing(state, "request-1");
  mutation.resolve({});
  await first;
  await pairing.rejectDevicePairing(state, "request-1");
  expect(request).toHaveBeenCalledTimes(2);
  devices.resolve({});
  await second;
});

it.each(actions)(
  "%s guards, refreshes, and releases decisions",
  async (method, run, isNode, failed) => {
    const { mutation, devices, nodes, request, state, settled, start } = setup();
    const current = isNode ? vi.fn() : request;
    current.mockReturnValueOnce(devices.promise).mockReturnValueOnce(nodes.promise);
    Object.assign(state, errors);
    const pending = start(run);
    const siblings = actions.filter((action) => action[2] === isNode);
    await Promise.all(siblings.map((action) => action[1](state, "request-1")));
    expect(request.mock.calls).toEqual([[method, { requestId: "request-1" }]]);
    expect(state).toMatchObject(errors);
    if (isNode) {
      state.client = { request: current };
      state.requestGeneration += 1;
    }
    settle(mutation, failed ? "pairing denied" : undefined);
    if (!failed || isNode) {
      await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(2));
      if (isNode) {
        expect(request).toHaveBeenCalledTimes(1);
        expect(state).toMatchObject(failed ? errors : { devicesError: null, lastError: null });
        nodes.resolve(nodeList);
        await vi.waitFor(() => expect(state.nodesLoading).toBe(false));
        expect(state.devicesLoading).toBe(true);
      }
      expect(settled).not.toHaveBeenCalled();
      expect(state.devicesError).toBe(failed ? errors.devicesError : null);
      devices.resolve(deviceList);
    }
    await pending;
    expect(state).toMatchObject({
      devicesList: failed && !isNode ? null : deviceList,
      devicesLoading: false,
      devicesError: failed ? "pairing denied" : null,
      ...(isNode ? { nodes: nodeList.nodes, lastError: failed ? errors.lastError : null } : {}),
    });
    current.mockReset().mockResolvedValue({ pending: [], paired: [], nodes: [] });
    await run(state, "request-1");
    expect(current.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
  },
);

it.each(transitions)("fences stale results: %s", async (transition) => {
  for (const failed of [false, true]) {
    const { mutation, request, state, start } = setup();
    request.mockReturnValue(mutation.promise);
    const replacement = vi.fn();
    state.devicesError = "current error";
    const pending = start(pairing.approveDevicePairing);
    const changes = {
      client: { client: { request: replacement } },
      generation: { requestGeneration: state.requestGeneration + 1 },
      disconnect: { connected: false },
    };
    Object.assign(state, changes[transition]);
    settle(mutation, failed ? "stale error" : undefined);
    await pending;
    expect(request.mock.calls).toEqual([["device.pair.approve", { requestId: "request-1" }]]);
    expect(replacement).not.toHaveBeenCalled();
    expect(state).toMatchObject({ devicesError: "current error", devicesList: null });
  }
});

it("preserves node failure through queued inventory refreshes", async () => {
  const fixture = setup(["devices", "nodes", "mutation"]);
  const { devices, nodes, mutation, request, state, start } = fixture;
  request.mockResolvedValue({ pending: [], paired: [], nodes: [] });
  const initialLoad = Promise.all([pairing.loadDevices(state), pairing.loadNodes(state)]);
  const pending = start(pairing.rejectNodePairingRequest);
  mutation.reject(new Error("pairing denied"));
  await pending;
  expect(state).toMatchObject({
    devicesLoading: true,
    nodesLoading: true,
    devicesQueuedRefresh: "quiet",
    nodesQueuedRefresh: "quiet",
    devicesError: "pairing denied",
  });
  devices.resolve(deviceList);
  nodes.resolve({ nodes: [] });
  await initialLoad;
  expect(request).toHaveBeenCalledTimes(5);
  expect(state).toMatchObject({
    devicesQueuedRefresh: "none",
    nodesQueuedRefresh: "none",
    devicesError: "pairing denied",
  });
});

it.each([actions[0], actions[2]])("%s: offline", async (_method, run) => {
  const { request, state } = setup();
  await run(pairing.createInitialDevicesState({ connected: true }), "request-1");
  state.connected = false;
  await run(state, "request-1");
  expect(request).not.toHaveBeenCalled();
});
