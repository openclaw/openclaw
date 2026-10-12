import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { getPairedDevice, withPairedDeviceRecords } from "../infra/device-pairing.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

const pairingHook = vi.hoisted(() => ({
  afterResolve: undefined as ((nodeId: string, caller: string) => Promise<void>) | undefined,
}));

vi.mock("../infra/device-pairing-node-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing-node-state.js")>();
  return {
    ...actual,
    resolveCurrentPairedDeviceNodeBinding: async (nodeId: string) => {
      // Connect notifications also resolve nodes in the background; the synchronous
      // caller identifies the dispatch path under test before the first await.
      const caller = new Error().stack ?? "";
      const current = await actual.resolveCurrentPairedDeviceNodeBinding(nodeId);
      // Interleave after the real lookup, before the registry's synchronous authority check.
      await pairingHook.afterResolve?.(nodeId, caller);
      return current;
    },
  };
});

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
let port: number;
const nodeClients: GatewayClient[] = [];

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

beforeEach(() => {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    throw new Error("active plugin registry is required for canvas node command tests");
  }
  if (
    !registry.nodeInvokePolicies.some((entry) => entry.policy.commands.includes("canvas.snapshot"))
  ) {
    registry.nodeInvokePolicies.push({
      pluginId: "canvas",
      pluginName: "Canvas",
      source: "test",
      rootDir: "extensions/canvas",
      pluginConfig: {},
      policy: {
        commands: ["canvas.snapshot"],
        defaultPlatforms: ["macos"],
        handle: (ctx) => ctx.invokeNode(),
      },
    });
  }
});

afterEach(async () => {
  pairingHook.afterResolve = undefined;
  for (const client of nodeClients.splice(0).toReversed()) {
    await client.stopAndWait();
  }
});

type InvokeFrame = { id: string; nodeId: string; command: string };

async function connectPairedNode(displayName: string) {
  const { identity } = await pairDeviceIdentity({
    name: displayName,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    platform: "macos",
    deviceFamily: "Mac",
  });
  const pairing = await requestNodePairing({
    nodeId: identity.deviceId,
    displayName,
    platform: "macos",
    deviceFamily: "Mac",
    commands: ["canvas.snapshot"],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.admin", "operator.write"],
  });
  const invokeFrame = createDeferred<InvokeFrame>();
  const received: InvokeFrame[] = [];
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: displayName,
    mode: GATEWAY_CLIENT_MODES.NODE,
    platform: "macos",
    deviceFamily: "Mac",
    scopes: [],
    commands: ["canvas.snapshot"],
    deviceIdentity: identity,
    onEvent: (event) => {
      if (event.event === "node.invoke.request") {
        const frame = event.payload as InvokeFrame;
        received.push(frame);
        invokeFrame.resolve(frame);
      }
    },
  });
  nodeClients.push(client);
  return { client, nodeId: identity.deviceId, invokeFrame: invokeFrame.promise, received };
}

type DispatchPath = "node-registry-private" | "request-authorization";

function afterNextResolution(nodeId: string, path: DispatchPath, run: () => Promise<void>) {
  pairingHook.afterResolve = async (resolvedNodeId, caller) => {
    if (resolvedNodeId === nodeId && caller.includes(path)) {
      pairingHook.afterResolve = undefined;
      await run();
    }
  };
}

function invokeCanvasSnapshot(nodeId: string, idempotencyKey: string) {
  return rpcReq(ws, "node.invoke", {
    nodeId,
    command: "canvas.snapshot",
    params: { format: "png" },
    idempotencyKey,
  });
}

const unsupportedEvent = {
  event: "test.pairing-publication",
  payload: { synthetic: true },
};

test("delivers node commands and node requests across an unrelated missed pairing revision", async () => {
  const nodeA = await connectPairedNode("publication-node-a");
  const nodeB = await connectPairedNode("publication-node-b");
  const publishUnrelatedRevision = async () => {
    await withPairedDeviceRecords(undefined, (devices) => {
      const other = devices[nodeB.nodeId];
      if (!other) {
        throw new Error("expected unrelated paired node");
      }
      other.lastSeenAtMs = (other.lastSeenAtMs ?? 0) + 1;
      return { value: undefined, persist: true };
    });
    await getPairedDevice(nodeB.nodeId);
  };

  afterNextResolution(nodeA.nodeId, "node-registry-private", publishUnrelatedRevision);
  const invoked = invokeCanvasSnapshot(nodeA.nodeId, "publication-unrelated-revision");
  const frame = await Promise.race([nodeA.invokeFrame, invoked.then(() => undefined)]);
  if (frame) {
    expect(frame).toMatchObject({ nodeId: nodeA.nodeId, command: "canvas.snapshot" });
    await nodeA.client.request("node.invoke.result", {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify({ snapshot: "synthetic" }),
    });
  }
  const result = await invoked;
  expect.soft(result.ok, result.error?.message).toBe(true);
  expect.soft(nodeA.received).toHaveLength(1);
  expect(pairingHook.afterResolve).toBeUndefined();

  afterNextResolution(nodeA.nodeId, "request-authorization", publishUnrelatedRevision);
  await expect.soft(nodeA.client.request("node.event", unsupportedEvent)).resolves.toEqual({
    ok: true,
    event: unsupportedEvent.event,
    handled: false,
    reason: "unsupported_event",
  });
  expect(pairingHook.afterResolve).toBeUndefined();
});

test.each(["token revoke", "token rotate", "unpair"] as const)(
  "refuses a node whose pairing changes during dispatch preparation: %s",
  async (change) => {
    const node = await connectPairedNode(`publication-${change.replaceAll(" ", "-")}`);
    const held = createDeferred();
    const release = createDeferred();
    afterNextResolution(node.nodeId, "node-registry-private", async () => {
      held.resolve();
      await release.promise;
    });
    const invoked = invokeCanvasSnapshot(node.nodeId, `publication-${change}`);
    try {
      await awaitGateBeforeSettlement(
        held.promise,
        invoked,
        "invoke settled before pairing lookup",
      );
      const changed =
        change === "unpair"
          ? await rpcReq(ws, "device.pair.remove", { deviceId: node.nodeId })
          : await rpcReq(
              ws,
              change === "token revoke" ? "device.token.revoke" : "device.token.rotate",
              {
                deviceId: node.nodeId,
                role: "node",
              },
            );
      expect(changed.ok, changed.error?.message).toBe(true);
    } finally {
      release.resolve();
    }
    const result = await invoked;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("node pairing changed while invocation was active");
    expect(node.received).toEqual([]);
    await expect(node.client.request("node.event", unsupportedEvent)).rejects.toThrow(
      /device removed|not connected|pairing changed/,
    );
    expect(node.received).toEqual([]);
  },
);
