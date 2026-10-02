import { describe, expect, it, vi } from "vitest";
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
  { name: "approve device", method: "device.pair.approve", run: approveDevicePairing },
  { name: "reject device", method: "device.pair.reject", run: rejectDevicePairing },
];
const nodeActions = [
  { name: "approve node", method: "node.pair.approve", run: approveNodePairingRequest },
  { name: "reject node", method: "node.pair.reject", run: rejectNodePairingRequest },
];

describe.each(deviceActions)("$name", ({ method, run }) => {
  it.each([false, true])(
    "keeps device refresh and error behavior when failed=%s",
    async (failed) => {
      const mutation = deferred<unknown>();
      const refresh = deferred<unknown>();
      const request = vi
        .fn()
        .mockReturnValueOnce(mutation.promise)
        .mockReturnValueOnce(refresh.promise);
      const state = createInitialDevicesState({ client: { request }, connected: true });
      state.devicesError = "previous error";
      let settled = false;
      const pending = run(state, "request-1").then(() => {
        settled = true;
      });
      expect(request.mock.calls).toEqual([[method, { requestId: "request-1" }]]);
      expect(state.devicesError).toBe("previous error");
      if (failed) {
        mutation.reject(new Error("pairing denied"));
        await pending;
        expect(request).toHaveBeenCalledTimes(1);
        expect(state.devicesError).toBe("pairing denied");
        return;
      }
      mutation.resolve({});
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]).toEqual(["device.pair.list", {}]);
      expect(settled).toBe(false);
      expect(state.devicesError).toBeNull();
      const devices = { pending: [], paired: [{ deviceId: "device-1" }] };
      refresh.resolve(devices);
      await pending;
      expect(state.devicesList).toEqual(devices);
      expect(state.devicesLoading).toBe(false);
    },
  );

  it.each(["client", "generation", "disconnect"] as const)(
    "ignores stale success and failure after %s changes",
    async (transition) => {
      for (const failed of [false, true]) {
        const mutation = deferred<unknown>();
        const request = vi.fn().mockReturnValue(mutation.promise);
        const replacement = vi.fn();
        const state = createInitialDevicesState({ client: { request }, connected: true });
        state.devicesError = "current error";
        const pending = run(state, "request-1");
        if (transition === "client") {
          state.client = { request: replacement };
        } else if (transition === "generation") {
          state.requestGeneration += 1;
        } else {
          state.connected = false;
        }
        if (failed) {
          mutation.reject(new Error("stale error"));
        } else {
          mutation.resolve({});
        }
        await pending;
        expect(request.mock.calls).toEqual([[method, { requestId: "request-1" }]]);
        expect(replacement).not.toHaveBeenCalled();
        expect(state.devicesError).toBe("current error");
        expect(state.devicesList).toBeNull();
      }
    },
  );
});

describe.each(nodeActions)("$name", ({ method, run }) => {
  it.each([false, true])(
    "refreshes the current client in parallel before settling when failed=%s",
    async (failed) => {
      const mutation = deferred<unknown>();
      const devices = deferred<unknown>();
      const nodes = deferred<unknown>();
      const original = vi.fn().mockReturnValue(mutation.promise);
      const current = vi
        .fn()
        .mockReturnValueOnce(devices.promise)
        .mockReturnValueOnce(nodes.promise);
      const state = createInitialDevicesState({ client: { request: original }, connected: true });
      state.devicesError = "previous device error";
      state.lastError = "previous node error";
      let settled = false;
      const pending = run(state, "request-1").then(() => {
        settled = true;
      });
      state.client = { request: current };
      state.requestGeneration += 1;
      if (failed) {
        mutation.reject(new Error("pairing denied"));
      } else {
        mutation.resolve({});
      }
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
      expect(settled).toBe(false);
      expect(state.devicesLoading).toBe(true);
      expect(state.devicesError).toBe(failed ? "previous device error" : null);
      devices.resolve({ pending: [], paired: [] });
      await pending;
      expect(state.nodes).toEqual([{ id: "node-1" }]);
      expect(state.devicesList).toEqual({ pending: [], paired: [] });
      expect(state.devicesError).toBe(failed ? "pairing denied" : null);
      expect(state.lastError).toBe(failed ? "previous node error" : null);
    },
  );
});

it("records node failure while an existing inventory load queues its quiet refresh", async () => {
  const devices = deferred<unknown>();
  const nodes = deferred<unknown>();
  const mutation = deferred<unknown>();
  const request = vi
    .fn()
    .mockReturnValueOnce(devices.promise)
    .mockReturnValueOnce(nodes.promise)
    .mockReturnValueOnce(mutation.promise)
    .mockResolvedValue({ pending: [], paired: [], nodes: [] });
  const state = createInitialDevicesState({ client: { request }, connected: true });
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

it.each([...deviceActions, ...nodeActions])(
  "$name skips unavailable connections",
  async ({ run }) => {
    const request = vi.fn();
    await run(createInitialDevicesState({ connected: true }), "request-1");
    await run(createInitialDevicesState({ client: { request }, connected: false }), "request-1");
    expect(request).not.toHaveBeenCalled();
  },
);
