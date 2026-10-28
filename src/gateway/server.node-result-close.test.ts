import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { writeConfigFile } from "../config/config.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { respondToNodeShutdown } from "./node-shutdown.test-support.js";
import { GatewayNodeLifecycleDispatchTracker } from "./server/ws-connection/node-lifecycle-dispatch.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, startServer, writeSessionStore } from "./test-helpers.js";
import { testState } from "./test-helpers.runtime-state.js";
import { sessionStoreEntry } from "./test/server-sessions.test-helpers.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./worker-environments/device-provider-identity.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

const pairingRead = vi.hoisted(() => ({
  blocked: null as ReturnType<typeof createDeferred<void>> | null,
  onBlocked: null as (() => void) | null,
}));

vi.mock("../infra/device-pairing-node-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing-node-state.js")>();
  return {
    ...actual,
    resolveCurrentPairedDeviceNodeBinding: async (nodeId: string) => {
      const current = await actual.resolveCurrentPairedDeviceNodeBinding(nodeId);
      if (pairingRead.blocked) {
        pairingRead.onBlocked?.();
        await pairingRead.blocked.promise;
      }
      return current;
    },
  };
});

installGatewayTestHooks({ scope: "suite" });

const RUNNER_SESSION_ID = "session-runner-socket-close";
const RUNNER_SESSION_KEY = "agent:main:runner-socket-close";
const RUNNER_ENVIRONMENT_ID = "environment-runner-socket-close";
const RUNNER_BUNDLE_HASH = "a".repeat(64);

async function pairNode(name: string, commands: string[]) {
  const paired = await pairDeviceIdentity({
    name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: paired.identity.deviceId,
    platform: "linux",
    deviceFamily: "Linux",
    commands,
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write"],
  });
  return paired;
}

type ClientOptions = Parameters<typeof connectGatewayClient>[0];
type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
type InvokeFrame = { id: string; nodeId: string; command: string; paramsJSON: string };
type RunnerRow = { placement?: { runner?: { status?: string } } };
type RunnerList = { sessions?: Array<RunnerRow & { sessionId?: string }> };
type ListedNode = { nodeId?: string; connected?: boolean; commands?: string[] };
function connect(url: string, role: "operator" | "node", options: Partial<ClientOptions>) {
  const isNode = role === "node";
  return connectGatewayClient({
    url,
    token: "secret",
    role,
    clientName: isNode ? GATEWAY_CLIENT_NAMES.NODE_HOST : GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    mode: isNode ? GATEWAY_CLIENT_MODES.NODE : GATEWAY_CLIENT_MODES.BACKEND,
    scopes: isNode ? [] : ["operator.admin", "operator.read", "operator.write"],
    ...(isNode ? { platform: "linux", deviceFamily: "Linux" } : {}),
    ...options,
  });
}
const request = <T = unknown>(client: Client, method: string, params: unknown = {}) =>
  client.request<T>(method, params, { timeoutMs: 10_000 });
const stopClients = (...clients: Array<Client | undefined>) =>
  Promise.allSettled(
    clients.flatMap((client) => (client ? [client.stopAndWait({ timeoutMs: 1_000 })] : [])),
  );
const inventory = (environmentSession?: number) => ({
  protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
  workerHost: { enabled: true, capacity: { total: 1, available: 1 }, environmentSession },
});
const runnerStatus = (result: RunnerList) =>
  result.sessions?.find((entry) => entry.sessionId === RUNNER_SESSION_ID)?.placement?.runner
    ?.status;
async function terminateNode(node: Client) {
  const socket = Reflect.get(node, "ws") as { terminate?: () => void } | null;
  const stopped = node.stopAndWait({ timeoutMs: 1_000 });
  socket?.terminate?.();
  await stopped;
}

async function seedActiveDevicePlacement(nodeId: string): Promise<void> {
  const environments = await createWorkerEnvironmentStore();
  const placements = createWorkerSessionPlacementStore();
  const credential = (sessionId: string | null) => ({
    credentialHash: hashWorkerCredential(sessionId ?? "unbound"),
    sessionId,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  });
  const transition = (
    params: Omit<Parameters<typeof environments.transition>[0], "environmentId">,
  ) => environments.transition({ environmentId: RUNNER_ENVIRONMENT_ID, ...params });
  await environments.createIntent({
    environmentId: RUNNER_ENVIRONMENT_ID,
    providerId: DEVICE_WORKER_PROVIDER_ID,
    profileId: `device:${nodeId}`,
    profileSnapshot: { install: "bundle", settings: { device: nodeId } },
    provisionOperationId: `provision:${RUNNER_ENVIRONMENT_ID}`,
  });
  await transition({ from: "requested", to: "provisioning" });
  await transition({
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `lease:${RUNNER_ENVIRONMENT_ID}`,
      nodeDeviceId: nodeId,
      sshEndpoint: null,
      sharedHost: true,
      bootstrapReceipt: {
        bundleHash: RUNNER_BUNDLE_HASH,
        openclawVersion: "2026.8.19",
        protocolFeatures: [
          WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
          WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
        ],
        installKind: "bundle",
      },
      credential: credential(null),
    },
  });
  const attached = await transition({
    from: "ready",
    to: "attached",
    patch: {
      attachedSessionIds: [RUNNER_SESSION_ID],
      credential: credential(RUNNER_SESSION_ID),
    },
  });

  let placement = await placements.startDispatch({
    sessionId: RUNNER_SESSION_ID,
    sessionKey: RUNNER_SESSION_KEY,
    agentId: "main",
  });
  const environment = { environmentId: RUNNER_ENVIRONMENT_ID };
  const bundle = { ...environment, workerBundleHash: RUNNER_BUNDLE_HASH };
  const workspace = {
    ...bundle,
    workspaceBaseManifestRef: "manifest-runner-socket-close",
    remoteWorkspaceDir: "/workspace/runner-socket-close",
  };
  for (const [from, to, patch] of [
    ["requested", "provisioning", environment],
    ["provisioning", "syncing", bundle],
    ["syncing", "starting", workspace],
    ["starting", "active", { ...workspace, activeOwnerEpoch: attached.ownerEpoch }],
  ] as const) {
    placement = await placements.transition({
      sessionId: RUNNER_SESSION_ID,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  await writeSessionStore({
    entries: { [RUNNER_SESSION_KEY]: sessionStoreEntry(RUNNER_SESSION_ID) },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  releaseBlockedPairingRead();
});

test.each([
  ["a terminal node result admitted before close wins over disconnect cleanup", false],
  ["pairing removal still fences a terminal node result while close drains", true],
] as const)("%s", async (_name, removePairingDuringDrain) => {
  const pairedNode = await pairNode("node-result-before-close", ["camera.list"]);
  const nodeId = pairedNode.identity.deviceId;
  await writeConfigFile({
    gateway: { nodes: { commands: { allow: ["camera.list"] } } },
  });

  const { port, server } = await startServer("secret");
  const url = `ws://127.0.0.1:${port}`;
  let operator: Client | undefined;
  let node: Client | undefined;
  const { promise: invokeFrame, resolve: resolveInvokeFrame } = createDeferred<InvokeFrame>();

  try {
    operator = await connect(url, "operator", {});
    const controller = operator;
    node = await connect(url, "node", {
      commands: ["camera.list"],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload) {
          return;
        }
        resolveInvokeFrame(event.payload as InvokeFrame);
      },
    });
    const invoked = request(operator, "node.invoke", {
      nodeId,
      command: "camera.list",
      timeoutMs: 10_000,
      idempotencyKey: randomUUID(),
    });
    const frame = await awaitGateBeforeSettlement(
      invokeFrame,
      invoked,
      "node.invoke settled without sending a node request",
    );

    pairingRead.blocked = createDeferred();
    const pairingReadStarted = createDeferred();
    pairingRead.onBlocked = pairingReadStarted.resolve;
    const drainSpy = vi.spyOn(GatewayNodeLifecycleDispatchTracker.prototype, "drain");
    const resultAck = request(node, "node.invoke.result", {
      id: frame.id,
      nodeId: frame.nodeId,
      ok: true,
      payloadJSON: JSON.stringify({ completed: "before-close" }),
    }).catch((error: unknown) => error);
    await pairingReadStarted.promise;
    await terminateNode(node);
    node = undefined;
    await vi.waitFor(() => expect(drainSpy).toHaveBeenCalledOnce());
    if (removePairingDuringDrain) {
      await request(operator, "node.pair.remove", { nodeId });
    }
    pairingRead.blocked.resolve();

    if (removePairingDuringDrain) {
      await expect(invoked).rejects.toThrow("node pairing changed while invocation was active");
    } else {
      await expect(invoked).resolves.toMatchObject({
        ok: true,
        nodeId,
        command: "camera.list",
        payload: { completed: "before-close" },
      });
    }
    await resultAck;
    await vi.waitFor(async () => {
      const listed = await request<{ nodes?: ListedNode[] }>(controller, "node.list");
      const listedNode = listed.nodes?.find((entry) => entry.nodeId === nodeId);
      if (removePairingDuringDrain) {
        expect(listedNode).toBeUndefined();
      } else {
        expect(listedNode?.connected).toBe(false);
      }
    });
  } finally {
    releaseBlockedPairingRead();
    await stopClients(node, operator);
    await server.close();
  }
});

test("publishes an offline device row on socket close without a session-list reload", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("runner availability proof requires the isolated Gateway state directory");
  }
  testState.sessionStorePath = path.join(stateDir, "runner-socket-close-sessions.json");
  const pairedNode = await pairNode("runner-availability-close", []);

  const { port, server } = await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: undefined }, () =>
    startServer("secret"),
  );
  const url = `ws://127.0.0.1:${port}`;
  let operator: Client | undefined;
  let node: Client | undefined;
  let armed = false;
  let availabilityEvents = 0;
  const { promise: availableRow, resolve: resolveAvailable } = createDeferred<unknown>();
  const { promise: offlineRow, resolve: resolveOffline } = createDeferred<unknown>();
  const expectedRow = (status: string) => ({
    key: RUNNER_SESSION_KEY,
    placement: { runner: { status } },
  });
  const connectRunner = () =>
    connect(url, "node", {
      commands: [],
      deviceIdentity: pairedNode.identity,
      onEvent: (event) => {
        if (event.event !== "node.invoke.request" || !event.payload || !node) {
          return;
        }
        const frame = event.payload as InvokeFrame;
        const reply = respondToNodeShutdown(node, frame);
        if (!reply) {
          throw new Error(`unexpected node cleanup command: ${frame.command}`);
        }
        void reply.catch(() => undefined);
      },
    });

  try {
    operator = await connect(url, "operator", {
      onEvent: (event) => {
        const payload = event.payload as { sessionKey?: string; session?: RunnerRow } | undefined;
        if (event.event !== "sessions.changed" || payload?.sessionKey !== RUNNER_SESSION_KEY) {
          return;
        }
        if (payload.session?.placement?.runner?.status === "available") {
          resolveAvailable(payload.session);
        } else if (armed && payload.session?.placement?.runner?.status === "offline") {
          availabilityEvents += 1;
          resolveOffline(payload.session);
        }
      },
    });
    await seedActiveDevicePlacement(pairedNode.identity.deviceId);
    await operator.request("sessions.subscribe", {});
    const controller = operator;
    node = await connectRunner();
    await request(node, "node.runnerInventory.update", inventory());
    const listRunnerStatus = async () =>
      runnerStatus(await request<RunnerList>(controller, "sessions.list"));
    expect(await listRunnerStatus()).toBe("available");
    expect(await availableRow).toMatchObject(expectedRow("available"));

    armed = true;
    await terminateNode(node);
    node = undefined;

    expect(await offlineRow).toMatchObject(expectedRow("offline"));
    expect(availabilityEvents).toBe(1);
    expect(await listRunnerStatus()).toBe("offline");
  } finally {
    try {
      // Reconnect for physical cleanup: losing transport does not prove the worker stopped.
      node ??= await connectRunner();
      await node.request("node.runnerInventory.update", inventory(1));
      await server.close();
    } finally {
      await stopClients(node, operator);
    }
  }
});

function releaseBlockedPairingRead(): void {
  pairingRead.blocked?.resolve();
  pairingRead.onBlocked = null;
  pairingRead.blocked = null;
}
