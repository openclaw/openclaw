import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { NODE_WORKSPACE_DRAIN_COMMAND } from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  workspaceCommandPayload,
  workspaceSnapshot,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import type { NodeWorkerWorkspaceBinding } from "./node-worker-workspace-actions.js";

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

const fakeBinding: NodeWorkerWorkspaceBinding = {
  source: { kind: "local", path: "/tmp" },
  manifestRef: "ref-1",
  remoteWorkspaceDir: "/node/workspace",
};

describe("node worker tunnel workspace command deadline", () => {
  it.each([300_000, -300_000])(
    "keeps the workspace command deadline on the monotonic clock across a %i ms wall-clock jump",
    async (wallClockStepMs) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const perfSpy = vi.spyOn(performance, "now");
      const dateSpy = vi.spyOn(Date, "now");
      let monotonicMs = 0;
      let wallMs = 0;
      perfSpy.mockImplementation(() => monotonicMs);
      dateSpy.mockImplementation(() => wallMs);
      try {
        const record = environment();
        const nodeTransport = transport();
        let execCount = 0;
        let secondCallTimeoutMs: number | undefined;
        const invokeMock = vi.fn(async (request: Parameters<typeof nodeTransport.invoke>[0]) => {
          if (request.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
            return { ok: true, payloadJSON: "null" } as const;
          }
          const input = request.params as { argv?: string[] };
          if (input.argv?.[0] === NODE_WORKSPACE_DRAIN_COMMAND) {
            return {
              ok: true,
              payloadJSON: workspaceCommandPayload("/node/workspace", {
                stdout: "drained\n",
              }),
            } as const;
          }
          execCount += 1;
          if (execCount === 1) {
            wallMs += wallClockStepMs;
            return {
              ok: false,
              error: { code: "DISCONNECTED", message: "transient" },
            } as const;
          }
          secondCallTimeoutMs = request.timeoutMs;
          request.onDispatchReady?.("invoke-ready");
          return {
            ok: true,
            payloadJSON: workspaceCommandPayload("/node/workspace", {
              stdout: "ok\n",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            }),
          } as const;
        });
        nodeTransport.invoke = invokeMock;
        const transfer = workspaceTransfer({
          prepareSync: vi.fn(async () => ({
            snapshot: workspaceSnapshot("/node/workspace"),
            token: "download-token",
          })),
          revoke: vi.fn(async () => {}),
        });
        const manager = createNodeWorkerTunnelManager({
          gatewayDeviceId: "gateway-device-1",
          getEnvironment: () => record,
          listEnvironments: () => [record],
          getTransport: () => nodeTransport,
          launchNodeWorker: vi.fn(),
          validateWorkerTurn: () => true,
          workspaceTransfer: transfer,
        });
        manager.bindWorkspaceBindingResolver(async () => fakeBinding);

        const handle = await manager.start(startRequest());

        const result = handle.runWorkspaceCommand({
          argv: ["pwd"],
          transportRetry: "idempotent",
          timeoutMs: 10_000,
        });

        monotonicMs += 200;
        await vi.advanceTimersByTimeAsync(200);

        const resolved = await result;
        expect(resolved.code).toBe(0);
        expect(execCount).toBe(2);
        expect(secondCallTimeoutMs).toBeDefined();
        expect(secondCallTimeoutMs!).toBeGreaterThan(9_000);
        expect(secondCallTimeoutMs!).toBeLessThanOrEqual(15_000);

        await handle.stop();
      } finally {
        dateSpy.mockRestore();
        perfSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
