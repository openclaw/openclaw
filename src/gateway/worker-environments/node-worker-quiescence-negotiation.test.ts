import { expect, it, vi } from "vitest";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceCommandPayload,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";

it.each([
  "legacy",
  "native",
  "upgrade-during-acquire",
  "native-abandoned",
  "native-abandoned-release-fails",
] as const)("negotiates lease and foreground ownership through the tunnel (%s)", async (mode) => {
  const record = environment();
  const nodeTransport = transport();
  const [node] = await nodeTransport.listCurrentNodes();
  if (!node) {
    throw new Error("missing fixture node");
  }
  const native = mode.startsWith("native");
  let supported = native;
  let abandon = mode.startsWith("native-abandoned");
  let failRelease = mode === "native-abandoned-release-fails";
  let upgradeOnRead = false;
  nodeTransport.getCurrentNode = async () => {
    const current = {
      ...node,
      workerHost: {
        enabled: true as const,
        capacity: node.workerHost.capacity,
        environmentSession: 1 as const,
        ...(supported ? { workspaceQuiescence: 1 as const } : {}),
      },
    };
    if (upgradeOnRead) {
      supported = true;
    }
    return current;
  };
  const requests: NodeWorkerWorkspaceExecInput[] = [];
  const legacyNonce = "b".repeat(32);
  nodeTransport.invoke = withWorkspaceDrain(async ({ command, params, onDispatchReady }) => {
    onDispatchReady?.("workspace-invoke");
    if (command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND) {
      return { ok: true, payloadJSON: "null" };
    }
    const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(params));
    requests.push(input);
    if (abandon && input.quiescence?.action === "acquire") {
      abandon = false;
      throw new Error("acquisition response lost");
    }
    if (failRelease && input.quiescence?.action === "release") {
      failRelease = false;
      throw new Error("recovery response lost");
    }
    const nonce = input.quiescence?.nonce ?? legacyNonce;
    return {
      ok: true,
      payloadJSON: workspaceCommandPayload("/node/workspace", {
        stdout:
          input.quiescence?.action === "renew" || input.argv.includes("final")
            ? "renewed " + nonce + "\n"
            : "quiesced " + nonce + "\n",
      }),
    };
  });
  const transfer = workspaceTransfer();
  transfer.prepareRepository = vi.fn(async () => {});
  const manager = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-device-1",
    getEnvironment: () => record,
    listEnvironments: () => [record],
    getTransport: () => nodeTransport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: () => true,
    workspaceTransfer: transfer,
  });
  manager.bindWorkspaceBindingResolver(async () => ({
    source: {
      kind: "repository",
      baseCommit: "a".repeat(40),
      baseManifestRef: "sha256:" + "b".repeat(64),
    },
    manifestRef: "sha256:" + "b".repeat(64),
    remoteWorkspaceDir: "/node/workspace",
  }));
  const handle = await manager.start(startRequest());
  upgradeOnRead = mode === "upgrade-during-acquire";
  if (mode.startsWith("native-abandoned")) {
    await expect(handle.quiesceWorkspace("/node/workspace")).rejects.toThrow(
      /acquisition response lost|recovery did not complete/,
    );
    expect(requests.map((input) => input.quiescence?.action)).toEqual(["acquire", "release"]);
    expect(requests[1]?.quiescence?.nonce).toBe(requests[0]?.quiescence?.nonce);
    // Only a real exact-nonce release acknowledgement may unpin the dialect.
    if (mode === "native-abandoned-release-fails") {
      supported = false;
      const before = requests.length;
      await expect(
        handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "never" }),
      ).rejects.toThrow("quiescence support changed");
      expect(requests).toHaveLength(before);
      supported = true;
      await handle.runWorkspaceCommand({
        argv: requests[0]!.argv,
        transportRetry: "never",
        quiescence: { action: "release", nonce: requests[0]!.quiescence!.nonce },
      });
    }
    supported = false;
    await handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "never" });
    expect(requests.at(-1)).not.toHaveProperty("nativeProcessOwner");
    supported = true;
    requests.length = 0;
  }
  const lease = await handle.quiesceWorkspace("/node/workspace");
  try {
    await handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "never" });
    await lease.assertActive();
    expect(requests[0]?.quiescence?.action).toBe(native ? "acquire" : undefined);
    expect(requests[0]).not.toHaveProperty("nativeProcessOwner");
    expect(requests[1]?.nativeProcessOwner).toBe(mode === "legacy" ? undefined : true);
    expect(requests[2]?.quiescence?.action).toBe(native ? "renew" : undefined);
    expect(requests[2]).not.toHaveProperty("nativeProcessOwner");
    if (!native) {
      expect(requests[0]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
      expect(requests[2]?.argv).toContain(legacyNonce);
    }
    if (native) {
      supported = false;
      const before = requests.length;
      await expect(
        handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "idempotent" }),
      ).rejects.toThrow("quiescence support changed");
      await expect(lease.assertActive()).rejects.toThrow("quiescence support changed");
      expect(requests).toHaveLength(before);
      supported = true;
      await lease.resume();
      supported = false;
      await handle.runWorkspaceCommand({ argv: ["node", "-e", "0"], transportRetry: "never" });
      expect(requests.at(-1)).not.toHaveProperty("nativeProcessOwner");
    }
  } finally {
    supported = mode !== "legacy";
    await lease.resume();
    await handle.stop();
  }
});
