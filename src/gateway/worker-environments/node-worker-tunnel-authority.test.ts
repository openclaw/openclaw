import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";

describe("node worker tunnel source authority", () => {
  it("does not expose a tunnel after authority closes during workspace binding", async () => {
    const record = environment();
    const binding = createDeferred<undefined>();
    const transfer = workspaceTransfer();
    const prepareSync = vi.fn();
    transfer.prepareSync = prepareSync;
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: transfer,
    });
    const resolveBinding = vi.fn(async () => await binding.promise);
    manager.bindWorkspaceBindingResolver(resolveBinding);
    let authorized = true;
    const starting = manager.start({
      ...startRequest(),
      authorize: () => {
        if (!authorized) {
          throw new Error("session dispatch authority closed");
        }
      },
    });
    await vi.waitFor(() => expect(resolveBinding).toHaveBeenCalledOnce());
    authorized = false;
    binding.resolve(undefined);

    await expect(starting).rejects.toThrow("session dispatch authority closed");
    expect(prepareSync).not.toHaveBeenCalled();
    expect(manager.status(record.environmentId)).toBe("stopped");
  });

  it("joins same-owner starts while workspace binding resolution is pending", async () => {
    const record = environment();
    const workspaceBinding = createDeferred<undefined>();
    const resolveWorkspaceBinding = vi.fn(async () => await workspaceBinding.promise);
    const manager = createNodeWorkerTunnelManager({
      gatewayDeviceId: "gateway-device-1",
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: transport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => true,
      workspaceTransfer: workspaceTransfer(),
    });
    manager.bindWorkspaceBindingResolver(resolveWorkspaceBinding);

    const first = manager.start(startRequest());
    await vi.waitFor(() => expect(resolveWorkspaceBinding).toHaveBeenCalledOnce());
    const second = manager.start(startRequest());
    let authorized = true;
    const closed = new Error("joining source closed");
    const authorize = () => {
      if (!authorized) {
        throw closed;
      }
    };
    const joining = manager.start({ ...startRequest(), authorize });
    const rejected = expect(joining).rejects.toBe(closed);
    authorized = false;
    workspaceBinding.resolve(undefined);

    const [firstHandle, secondHandle] = await Promise.all([first, second]);
    await rejected;
    expect(resolveWorkspaceBinding).toHaveBeenCalledOnce();
    expect(secondHandle).toBe(firstHandle);
    await expect(manager.start({ ...startRequest(), authorize })).rejects.toBe(closed);
    expect(manager.status(record.environmentId)).toBe("connected");
  });
});
