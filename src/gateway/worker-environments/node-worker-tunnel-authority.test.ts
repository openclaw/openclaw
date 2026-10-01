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
  it.each(["start", "session-command", "aborted-session-command"] as const)(
    "does not expose a tunnel after %s authority closes during workspace binding",
    async (operation) => {
      const record = { ...environment(), sharedHost: false };
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
      const resolving = createDeferred();
      const resolveBinding = vi.fn(async () => {
        resolving.resolve();
        return await binding.promise;
      });
      manager.bindWorkspaceBindingResolver(resolveBinding);
      let authorized = true;
      const controller = new AbortController();
      const authorize = () => {
        if (!authorized) {
          throw new Error("session dispatch authority closed");
        }
      };
      const starting =
        operation === "start"
          ? manager.start({ ...startRequest(), authorize })
          : manager.runSessionCommand(
              { ...startRequest(), sessionKey: "agent:main:session-1" },
              {
                argv: ["pwd"],
                transportRetry: "never",
                assertCurrent: authorize,
                signal: controller.signal,
              },
            );
      try {
        await resolving.promise;
        if (operation === "aborted-session-command") {
          controller.abort(new Error("session dispatch authority closed"));
        } else {
          authorized = false;
        }
        binding.resolve(undefined);

        await expect(starting).rejects.toThrow("session dispatch authority closed");
        expect(prepareSync).not.toHaveBeenCalled();
        expect(manager.status(record.environmentId)).toBe("stopped");
      } finally {
        binding.resolve(undefined);
        await starting.catch(() => undefined);
        await manager.stop(record.environmentId, record.ownerEpoch);
      }
    },
  );

  it("joins same-owner starts while workspace binding resolution is pending", async () => {
    const record = environment();
    const workspaceBinding = createDeferred<undefined>();
    const resolving = createDeferred();
    const resolveWorkspaceBinding = vi.fn(async () => {
      resolving.resolve();
      return await workspaceBinding.promise;
    });
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
    await resolving.promise;
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

    try {
      const [firstHandle, secondHandle] = await Promise.all([first, second]);
      await rejected;
      expect(resolveWorkspaceBinding).toHaveBeenCalledOnce();
      expect(secondHandle).toBe(firstHandle);
      await expect(manager.start({ ...startRequest(), authorize })).rejects.toBe(closed);
      expect(manager.status(record.environmentId)).toBe("connected");
    } finally {
      await Promise.allSettled([first, second, joining]);
      await manager.stop(record.environmentId, record.ownerEpoch);
    }
  });
});
