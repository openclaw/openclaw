import { assert, expect, it, vi } from "vitest";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import {
  createManager,
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceReply,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";

it.each([
  "legacy",
  "native",
  "upgrade-during-acquire",
  "native-abandoned",
  "native-abandoned-release-fails",
] as const)("negotiates lease and foreground ownership through the tunnel (%s)", async (mode) => {
  const nodeTransport = transport();
  const [node] = await nodeTransport.listCurrentNodes();
  assert(node, "missing fixture node");
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
    supported ||= upgradeOnRead;
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
    return workspaceReply("/node/workspace", {
      stdout:
        input.quiescence?.action === "renew" || input.argv.includes("final")
          ? "renewed " + nonce + "\n"
          : "quiesced " + nonce + "\n",
    });
  });
  const manager = createManager(environment(), {
    getTransport: () => nodeTransport,
    workspaceTransfer: workspaceTransfer({ prepareRepository: vi.fn(async () => {}) }),
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
  const run = (overrides: Partial<Parameters<typeof handle.runWorkspaceCommand>[0]> = {}) =>
    handle.runWorkspaceCommand({
      argv: ["node", "-e", "0"],
      transportRetry: "never",
      ...overrides,
    });
  const expectBlocked = async (attempt: () => Promise<unknown>) => {
    const before = requests.length;
    await expect(attempt()).rejects.toThrow("quiescence support changed");
    expect(requests).toHaveLength(before);
  };
  const runLegacy = async () => {
    supported = false;
    await run();
    expect(requests.at(-1)).not.toHaveProperty("nativeProcessOwner");
  };
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
      await expectBlocked(run);
      supported = true;
      await run({
        argv: requests[0]!.argv,
        quiescence: { action: "release", nonce: requests[0]!.quiescence!.nonce },
      });
    }
    await runLegacy();
    supported = true;
    requests.length = 0;
  }
  const lease = await handle.quiesceWorkspace("/node/workspace");
  try {
    await run();
    await lease.assertActive();
    expect([requests[0]?.quiescence?.action, requests[2]?.quiescence?.action]).toEqual(
      native ? ["acquire", "renew"] : [undefined, undefined],
    );
    expect(requests[1]?.nativeProcessOwner).toBe(mode === "legacy" ? undefined : true);
    expect(requests[0]).not.toHaveProperty("nativeProcessOwner");
    expect(requests[2]).not.toHaveProperty("nativeProcessOwner");
    if (!native) {
      expect(requests[0]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
      expect(requests[2]?.argv).toContain(legacyNonce);
    }
    if (native) {
      supported = false;
      await expectBlocked(() => run({ transportRetry: "idempotent" }));
      await expectBlocked(() => lease.assertActive());
      supported = true;
      await lease.resume();
      await runLegacy();
    }
  } finally {
    supported = mode !== "legacy";
    await lease.resume();
    await handle.stop();
  }
});
