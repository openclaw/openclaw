import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { parseNodeWorkerEnvironmentStopInput } from "../../worker/node-supervisor-protocol.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import { environment, transport, workspaceTransfer } from "./node-worker-tunnel.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves attached app processes through Gateway shutdown and same-epoch reconnect", async () => {
  const root = tempDirs.make("attached-workspace-reconnect-");
  const workspace = new NodeWorkerWorkspaceRuntime({
    root,
    env: { PATH: path.dirname(process.execPath), HOME: root, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  const record = {
    ...environment(),
    providerId: "crabbox",
    sharedHost: false,
    attachedSessionIds: [],
    profileSnapshot: { executionMode: "worker-turn" as const, settings: {} },
  };
  const binding = {
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId: "conversation-1",
    sessionKey: "agent:main:conversation-1",
  };
  const gatewayDeviceId = "gateway-device-1";
  const nodeTransport = transport();
  nodeTransport.invoke = async (request) => {
    expect(request.isDispatchAuthorized()).toBe(true);
    request.onDispatchReady?.("attached-command");
    if (request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
      await workspace.processes.stopEnvironment(
        parseNodeWorkerEnvironmentStopInput(JSON.stringify(request.params)),
      );
      return { ok: true, payloadJSON: "null" };
    }
    return {
      ok: true,
      payloadJSON: JSON.stringify(
        await workspace.exec(
          parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params)),
          request.signal,
        ),
      ),
    };
  };
  const createManager = () =>
    createNodeWorkerTunnelManager({
      gatewayDeviceId,
      getEnvironment: () => record,
      listEnvironments: () => [record],
      getTransport: () => nodeTransport,
      launchNodeWorker: vi.fn(),
      validateWorkerTurn: () => false,
      workspaceTransfer: { ...workspaceTransfer(), closeAll: vi.fn(async () => {}) },
    });
  const managers = [createManager()];
  const start = (manager: ReturnType<typeof createManager>, processId: string) =>
    manager.runSessionCommand(binding, {
      argv: [
        "node",
        "-e",
        'const s = require("node:http").createServer((_, r) => r.end("same app")); s.listen(0, "127.0.0.1", () => console.log("http://127.0.0.1:" + s.address().port));',
      ],
      process: { action: "start", processId },
      transportRetry: "never",
    });
  const read = (manager: ReturnType<typeof createManager>, processId: string) =>
    manager.runSessionCommand(binding, {
      argv: ["openclaw-internal-workspace-process"],
      process: { action: "status", processId },
      transportRetry: "never",
    });
  try {
    const first = managers[0]!;
    await start(first, "first-app");
    let firstUrl = "";
    await vi.waitFor(async () => {
      firstUrl = (await read(first, "first-app")).stdout.trim();
      expect(firstUrl).toMatch(/^http:\/\/127.0.0.1:\d+$/);
    });
    await first.stopAll();
    expect(await (await fetch(firstUrl)).text()).toBe("same app");
    const resumed = createManager();
    managers.push(resumed);
    expect((await read(resumed, "first-app")).process?.state).toBe("running");
    await start(resumed, "second-app");
    await vi.waitFor(async () =>
      expect((await read(resumed, "second-app")).stdout.trim()).toMatch(/^http:\/\/127.0.0.1:\d+$/),
    );
    expect(record.ownerEpoch).toBe(binding.ownerEpoch);
    expect(record.profileSnapshot.executionMode).toBe("worker-turn");
    await resumed.stopAll();
    expect(await (await fetch(firstUrl)).text()).toBe("same app");
    await workspace.processes.stopEnvironment({
      ...binding,
      gatewayNamespace: nodeWorkerGatewayNamespace(gatewayDeviceId),
    });
    await expect(fetch(firstUrl)).rejects.toThrow();
  } finally {
    await Promise.allSettled(managers.map((manager) => manager.stopAll()));
    await workspace.processes.close();
  }
});
