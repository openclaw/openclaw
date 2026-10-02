// Role allowlist update tests cover operator-driven gateway updates, node lists,
// device/node pairing state, restart sentinels, and runtime plugin visibility.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { captureEnv, deleteTestEnvValue } from "../test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientName,
} from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import type { HealthSummary } from "./health/types.js";
import type { ManagedGatewayConfigReloaderParams } from "./server-reload-contracts.js";

const readonlyPreparation = vi.hoisted(() => ({
  prepared: [] as Array<{ pathname: string; location?: string; progressed: boolean }>,
  turns: [] as Promise<void>[],
}));

vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  const observe = (pathname: string) => {
    let progressed = false;
    readonlyPreparation.turns.push(
      new Promise<void>((resolve) => {
        setImmediate(() => {
          progressed = true;
          resolve();
        });
      }),
    );
    return (prepared?: { location: string }) =>
      readonlyPreparation.prepared.push({
        pathname,
        location: prepared?.location,
        progressed,
      });
  };
  const observeAsync =
    <Args extends [string, ...unknown[]], Prepared extends { location: string }>(
      prepare: (...args: Args) => Promise<Prepared>,
    ) =>
    async (...args: Args) => {
      const finish = observe(args[0]);
      let prepared: Prepared | undefined;
      try {
        prepared = await prepare(...args);
        return prepared;
      } finally {
        finish(prepared);
      }
    };
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync(pathname: string) {
      const finish = observe(pathname);
      let prepared: ReturnType<typeof actual.prepareSqliteReadOnlyLocationSync> | undefined;
      try {
        prepared = actual.prepareSqliteReadOnlyLocationSync(pathname);
        return prepared;
      } finally {
        finish(prepared);
      }
    },
    prepareSqliteReadOnlyLocation: observeAsync(actual.prepareSqliteReadOnlyLocation),
    startSqliteReadOnlyLocationAsync(
      ...args: Parameters<typeof actual.startSqliteReadOnlyLocationAsync>
    ) {
      const finish = observe(args[0]);
      try {
        const preparation = actual.startSqliteReadOnlyLocationAsync(...args);
        void preparation.result.then(
          (prepared) => finish(prepared),
          () => finish(),
        );
        return preparation;
      } catch (error) {
        finish();
        throw error;
      }
    },
  };
});

const reloadFixture = vi.hoisted<{
  reconcileRuntimePolicy?: ManagedGatewayConfigReloaderParams["reconcileRuntimePolicy"];
}>(() => ({}));

vi.mock("./server-reload-managed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server-reload-managed.js")>();
  return {
    ...actual,
    startManagedGatewayConfigReloader: (params: ManagedGatewayConfigReloaderParams) => {
      reloadFixture.reconcileRuntimePolicy = params.reconcileRuntimePolicy;
      return actual.startManagedGatewayConfigReloader(params);
    },
  };
});

import { registerGatewayUpdateHistoryTests } from "./server.update-history.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

const nodeClients: GatewayClient[] = [];
afterEach(async () => {
  for (const client of nodeClients.splice(0).toReversed()) {
    await client.stopAndWait();
  }
});
installGatewayTestHooks({ scope: "suite" });
const updateDirs = useAutoCleanupTempDirTracker(afterEach);
const FAST_WAIT_OPTS = { timeout: 5_000, interval: 10 } as const;
type PollWaitOptions = { timeout: number; interval: number };

let ws: WebSocket;
let port: number;

async function withoutSupervisorHints<T>(fn: () => Promise<T>): Promise<T> {
  const envSnapshot = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }

  try {
    return await fn();
  } finally {
    envSnapshot.restore();
  }
}

function installCanvasNodePolicyForTest() {
  const registry = getActiveRuntimePluginRegistry();
  if (!registry) {
    throw new Error("active plugin registry is required for canvas node command tests");
  }
  if (
    registry.nodeInvokePolicies.some((entry) => entry.policy.commands.includes("canvas.snapshot"))
  ) {
    return;
  }
  registry.nodeInvokePolicies.push({
    pluginId: "canvas",
    pluginName: "Canvas",
    source: "test",
    rootDir: "extensions/canvas",
    pluginConfig: {},
    policy: {
      commands: ["canvas.snapshot"],
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    },
  });
}

beforeEach(() => {
  installCanvasNodePolicyForTest();
});

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

const connectNodeClient = async (params: {
  commands: string[];
  platform?: string;
  deviceFamily?: string;
  deviceIdentity?: DeviceIdentity;
  clientName?: GatewayClientName;
  displayName: string;
  onEvent?: (evt: { event?: string; payload?: unknown }) => void;
}) => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required for node test clients");
  }
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    role: "node",
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    clientDisplayName: params.displayName,
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: params.displayName,
    scopes: [],
    commands: params.commands,
    deviceIdentity: params.deviceIdentity,
    onEvent: params.onEvent,
    timeoutMessage: "timeout waiting for node to connect",
  });
  nodeClients.push(client);
  return client;
};

function requireNodeId(nodeId: string | undefined, label: string): string {
  if (!nodeId) {
    throw new Error(`expected connected node id for ${label}`);
  }
  return nodeId;
}

const approveAllPendingPairings = async () => {
  const list = await listDevicePairing();
  for (const pending of list.pending) {
    await approveDevicePairing(pending.requestId, {
      callerScopes: pending.scopes ?? ["operator.admin"],
    });
  }
};

const connectNodeClientWithPairing = async (params: Parameters<typeof connectNodeClient>[0]) => {
  try {
    return await connectNodeClient(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pairing required")) {
      throw error;
    }
    await approveAllPendingPairings();
    return await connectNodeClient(params);
  }
};

const connectNodeClientWithNodePairing = async (
  params: Parameters<typeof connectNodeClient>[0],
) => {
  const provisionalClient = await connectNodeClientWithPairing(params);
  const nodeId = await findConnectedNodeIdByDisplayName(params.displayName);

  await provisionalClient.stopAndWait();

  const request = await requestNodePairing({
    nodeId,
    displayName: params.displayName,
    platform: params.platform ?? "ios",
    deviceFamily: params.deviceFamily,
    commands: params.commands,
  });
  await approveNodePairing(request.request.requestId, {
    callerScopes: ["operator.admin", "operator.write"],
  });

  return await connectNodeClient(params);
};

async function findConnectedNodeByDisplayName(displayName: string) {
  const listRes = await rpcReq<{
    nodes?: Array<{
      nodeId: string;
      displayName?: string;
      connected?: boolean;
      commands?: string[];
    }>;
  }>(ws, "node.list", {});
  expect(listRes.ok, JSON.stringify(listRes.error)).toBe(true);
  return (listRes.payload?.nodes ?? []).find(
    (node) => node.connected && node.displayName === displayName,
  );
}

async function findConnectedNodeIdByDisplayName(displayName: string) {
  const node = await findConnectedNodeByDisplayName(displayName);
  return requireNodeId(node?.nodeId, displayName);
}

async function expectConnectedCommands(
  displayName: string,
  commands: string[],
  opts: PollWaitOptions = FAST_WAIT_OPTS,
) {
  await expect
    .poll(async () => {
      const node = await findConnectedNodeByDisplayName(displayName);
      return node?.commands?.toSorted() ?? [];
    }, opts)
    .toEqual(commands);
}

async function expectConnectedNodeCount(count: number) {
  await expect
    .poll(async () => {
      const listRes = await rpcReq<{ nodes?: Array<{ connected?: boolean }> }>(ws, "node.list", {});
      return listRes.payload?.nodes?.filter((node) => node.connected).length ?? 0;
    }, FAST_WAIT_OPTS)
    .toBe(count);
}

async function expectPendingPairingCommands(nodeId: string, commands: string[]) {
  const pending = await getPendingNodePairing(nodeId);
  expect(pending?.nodeId).toBe(nodeId);
  expect(pending?.commands).toEqual(commands);
}

async function getPendingNodePairing(nodeId: string) {
  const pairingList = await rpcReq<{
    pending?: Array<{ requestId?: string; nodeId?: string; commands?: string[] }>;
  }>(ws, "node.pair.list", {});
  expect(pairingList.ok).toBe(true);
  return (pairingList.payload?.pending ?? []).find((entry) => entry.nodeId === nodeId);
}

async function approvePendingNodePairing(nodeId: string, commands: string[]) {
  const pending = await getPendingNodePairing(nodeId);
  expect(pending?.commands).toEqual(commands);
  const approveRes = await rpcReq(ws, "node.pair.approve", { requestId: pending?.requestId });
  expect(approveRes.ok).toBe(true);
  return pending;
}

async function invokeCanvasSnapshot(nodeId: string, idempotencyKey: string) {
  return rpcReq(ws, "node.invoke", {
    nodeId,
    command: "canvas.snapshot",
    params: { format: "png" },
    idempotencyKey,
  });
}

async function expectCanvasSnapshotDenied(nodeId: string, idempotencyKey: string) {
  const res = await invokeCanvasSnapshot(nodeId, idempotencyKey);
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("node command not allowed");
}

function createInvokeCapture() {
  let resolveInvoke: ((payload: { id?: string; nodeId?: string }) => void) | null = null;
  const pendingPayloads: Array<{ id?: string; nodeId?: string }> = [];
  return {
    waitForInvoke: () => {
      const pending = pendingPayloads.shift();
      if (pending) {
        return Promise.resolve(pending);
      }
      if (resolveInvoke) {
        throw new Error("already waiting for a node invoke request");
      }
      return new Promise<{ id?: string; nodeId?: string }>((resolve) => {
        resolveInvoke = resolve;
      });
    },
    onEvent: (evt: { event?: string; payload?: unknown }) => {
      if (evt.event === "node.invoke.request") {
        const payload = evt.payload as { id?: string; nodeId?: string };
        if (resolveInvoke) {
          const resolve = resolveInvoke;
          resolveInvoke = null;
          resolve(payload);
          return;
        }
        pendingPayloads.push(payload);
      }
    },
  };
}

async function respondToInvoke(
  client: GatewayClient,
  payload: { id?: string; nodeId?: string },
  fallbackNodeId: string,
  payloadJSON: string | null = JSON.stringify({ ok: true }),
) {
  await client.request("node.invoke.result", {
    id: payload.id ?? "",
    nodeId: payload.nodeId ?? fallbackNodeId,
    ok: true,
    payloadJSON,
  });
}

function createDeviceIdentityForTest(prefix: string) {
  return loadOrCreateDeviceIdentity({
    path: path.join(
      os.tmpdir(),
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    ),
  });
}

describe("gateway role enforcement", () => {
  test("enforces operator and node permissions", async () => {
    const eventRes = await rpcReq(ws, "node.event", { event: "test", payload: { ok: true } });
    expect(eventRes.ok).toBe(false);
    expect(eventRes.error?.message ?? "").toContain("unauthorized role");

    const invokeRes = await rpcReq(ws, "node.invoke.result", {
      id: "invoke-1",
      nodeId: "node-1",
      ok: true,
    });
    expect(invokeRes.ok).toBe(false);
    expect(invokeRes.error?.message ?? "").toContain("unauthorized role");

    const nodeClient = await connectNodeClientWithNodePairing({
      commands: [],
      displayName: "node-role-enforcement",
    });

    const unsupportedEvent = await nodeClient.request<{
      ok: boolean;
      event?: string;
      handled?: boolean;
      reason?: string;
    }>("node.event", { event: "test.unsupported", payload: { ok: true } });
    expect(unsupportedEvent).toEqual({
      ok: true,
      event: "test.unsupported",
      handled: false,
      reason: "unsupported_event",
    });

    const binsPayload = await nodeClient.request("skills.bins", {});
    expect(Array.isArray(binsPayload?.bins)).toBe(true);

    await expect(nodeClient.request("status", {})).rejects.toThrow("unauthorized role");

    const healthPayload = await nodeClient.request<HealthSummary>("health", {});
    expect(healthPayload.ok).toBe(true);
  });
});

registerGatewayUpdateHistoryTests(() => port, readonlyPreparation);

describe("gateway update.run", () => {
  test("persists the accepted handoff before parking and restarting its foreground owner", async () => {
    await withoutSupervisorHints(async () => {
      const [installSurface, gatewayOwner, handoff, restart] = await Promise.all([
        import("../infra/update-runner-install-surface.js"),
        import("../infra/gateway-owner-lease.js"),
        import("../infra/update-managed-service-handoff.js"),
        import("../infra/restart.js"),
      ]);
      const startedAt = getFileLockProcessStartTime(process.pid);
      if (startedAt === null) {
        throw new Error("the foreground fixture requires the current process start identity");
      }
      const root = updateDirs.make("openclaw-update-role-");
      const entrypoint = path.join(root, "dist", "index.js");
      const surface = vi.spyOn(installSurface, "resolveUpdateInstallSurface").mockResolvedValue({
        kind: "git",
        mode: "git",
        root,
        packageRoot: root,
      });
      // The shared server starts below the CLI run loop that publishes its owner.
      const readOwner = vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
        owner: "role-update-owner",
        pid: process.pid,
        host: os.hostname(),
        startedAt,
        port,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });
      const start = vi
        .spyOn(handoff, "startManagedServiceUpdateHandoff")
        .mockImplementation(async (params) => {
          if (!params.handoffId) {
            throw new Error("expected an admitted update handoff identity");
          }
          return {
            status: "started",
            command: "openclaw update --yes --json",
            logPath: path.join(root, "handoff.log"),
            handoffId: params.handoffId,
            installRoot: params.root,
          };
        });
      const transfer = vi
        .spyOn(handoff, "transferManagedServiceUpdateHandoff")
        .mockImplementation(async (identity) => {
          const accepted = start.mock.calls[0]?.[0];
          expect(identity).toEqual({
            kind: "managed-update-handoff",
            handoffId: accepted?.handoffId,
            installRoot: root,
          });
          expect((await readRestartSentinel())?.payload).toMatchObject({
            kind: "update",
            status: "skipped",
            stats: {
              mode: "git",
              root,
              runId: accepted?.runId,
              handoffId: identity.handoffId,
              reason: "managed-service-handoff-started",
            },
          });
          return true;
        });
      const claim = vi.spyOn(handoff, "claimManagedServiceUpdateHandoff").mockReturnValue(true);
      const schedule = vi.spyOn(restart, "scheduleGatewayRestart");
      const restartSignal = vi.fn();
      process.on("SIGUSR2", restartSignal);

      try {
        await fs.mkdir(path.dirname(entrypoint));
        await fs.writeFile(entrypoint, "export {};\n");
        await fs.writeFile(
          path.join(root, "package.json"),
          '{"name":"openclaw","version":"1.0.0"}',
        );
        const res = await rpcReq<{ runId: string; ok: boolean }>(ws, "update.run", {
          sessionKey: "agent:main:whatsapp:dm:+15555550123",
          restartDelayMs: 0,
        });
        expect(res.ok).toBe(true);
        expect(res.payload).toMatchObject({
          ok: true,
          sentinel: { persisted: true },
          handoff: { status: "started" },
        });
        expect(start).toHaveBeenCalledOnce();
        expect(transfer).toHaveBeenCalledOnce();
        const accepted = start.mock.calls[0]?.[0];
        if (!res.payload || !accepted?.beforePark) {
          throw new Error("expected the accepted handoff's parking callback");
        }
        expect(accepted).toMatchObject({
          root,
          argv1: entrypoint,
          runId: res.payload.runId,
          supervisor: null,
          foregroundOrigin: { owner: "role-update-owner", pid: process.pid, startedAt, port },
          meta: { completionOwner: "gateway-restart", runId: res.payload.runId },
        });
        expect(getUpdateRun(res.payload.runId)?.status).toBe("running");
        expect(schedule).not.toHaveBeenCalled();
        expect(restartSignal).not.toHaveBeenCalled();

        await accepted.beforePark();
        await vi.waitFor(() => expect(restartSignal).toHaveBeenCalledOnce(), FAST_WAIT_OPTS);
        expect(restart.consumeGatewayRestartIntent()).toMatchObject({
          reason: "update.run",
          successorOwner: transfer.mock.calls[0]?.[0],
        });
      } finally {
        restart.resetGatewayRestartStateForInProcessRestart();
        process.off("SIGUSR2", restartSignal);
        schedule.mockRestore();
        claim.mockRestore();
        transfer.mockRestore();
        start.mockRestore();
        readOwner.mockRestore();
        surface.mockRestore();
      }
    });
  });
});

function nodeFixture(
  displayName: string,
  options: Partial<Omit<Parameters<typeof connectNodeClient>[0], "displayName">> = {},
) {
  return {
    displayName,
    commands: ["canvas.snapshot"],
    platform: "macos",
    deviceFamily: "Mac",
    deviceIdentity: createDeviceIdentityForTest(displayName),
    ...options,
  };
}

describe("gateway node command allowlist", () => {
  test("enforces command allowlists across node clients", async () => {
    const empty = nodeFixture("node-empty", {
      commands: [],
      platform: "ios",
      deviceFamily: undefined,
    });
    const emptyClient = await connectNodeClientWithNodePairing(empty);
    const emptyNodeId = await findConnectedNodeIdByDisplayName(empty.displayName);
    const missingRes = await rpcReq(ws, "node.invoke", {
      nodeId: emptyNodeId,
      command: "canvas.snapshot",
      params: {},
      idempotencyKey: "allowlist-2",
    });
    expect(missingRes.ok).toBe(false);
    expect(missingRes.error?.message).toContain("node command not allowed");
    await emptyClient.stopAndWait();
    await expectConnectedNodeCount(0);

    const invokeCapture = createInvokeCapture();
    const allowed = nodeFixture("node-allowed", {
      platform: "ios",
      deviceFamily: undefined,
      onEvent: invokeCapture.onEvent,
    });
    const allowedClient = await connectNodeClientWithNodePairing(allowed);
    const allowedNodeId = await findConnectedNodeIdByDisplayName(allowed.displayName);
    const invokeResP = invokeCanvasSnapshot(allowedNodeId, "allowlist-3");
    const payload = await invokeCapture.waitForInvoke();
    const requestId = payload.id ?? "";
    const nodeIdFromReq = payload.nodeId ?? "node-allowed";
    for (const [progress, message] of [
      [{ nodeId: "different-node", seq: 0, chunk: "" }, "nodeId mismatch"],
      [{ nodeId: nodeIdFromReq, seq: 0, chunk: "🐙".repeat(5_000) }, "progress chunk too large"],
    ] as const) {
      await expect(
        allowedClient.request("node.invoke.progress", { invokeId: requestId, ...progress }),
      ).rejects.toThrow(message);
    }
    await expect(
      allowedClient.request("node.invoke.progress", {
        invokeId: requestId,
        nodeId: nodeIdFromReq,
        seq: 0,
        chunk: "",
      }),
    ).resolves.toEqual({ ok: true, ignored: true });
    await respondToInvoke(allowedClient, payload, allowedNodeId);
    expect((await invokeResP).ok).toBe(true);

    for (const [id, result, expectedPayload] of [
      ["null", { payloadJSON: null, error: null }, undefined],
      ["object", { payloadJSON: { source: "payloadJSON" } }, { source: "payloadJSON" }],
      [
        "explicit",
        { payloadJSON: { source: "payloadJSON" }, payload: { source: "payload" } },
        { source: "payload" },
      ],
    ] as const) {
      const invokeResult = rpcReq<{ payload?: unknown; payloadJSON?: string | null }>(
        ws,
        "node.invoke",
        {
          nodeId: allowedNodeId,
          command: "canvas.snapshot",
          params: { format: "png" },
          idempotencyKey: `allowlist-${id}-payloadjson`,
        },
      );
      const captured = await invokeCapture.waitForInvoke();
      await allowedClient.request("node.invoke.result", {
        id: captured.id,
        nodeId: captured.nodeId,
        ok: true,
        ...result,
      });
      const response = await invokeResult;
      expect(response.ok).toBe(true);
      expect(response.payload?.payloadJSON).toBeNull();
      expect(response.payload?.payload).toEqual(expectedPayload);
    }
  });

  test("exposes and invokes live commands only after pending node pairing is approved", async () => {
    const invokeCapture = createInvokeCapture();
    const fixture = nodeFixture("node-approve-live-commands", {
      commands: ["canvas.snapshot", "system.run"],
      onEvent: invokeCapture.onEvent,
    });
    const nodeClient = await connectNodeClientWithPairing(fixture);
    await expectConnectedCommands(fixture.displayName, []);
    const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
    await expectPendingPairingCommands(nodeId, fixture.commands);
    const denied = await invokeCanvasSnapshot(nodeId, "pending-node-canvas");
    expect(denied.ok).toBe(false);
    expect(denied.error?.details).toMatchObject({ code: "PAIRING_CHANGED" });

    await approvePendingNodePairing(nodeId, fixture.commands);
    await expectConnectedCommands(fixture.displayName, fixture.commands, {
      timeout: 2_000,
      interval: 10,
    });
    const invokeResP = invokeCanvasSnapshot(nodeId, "approved-live-node-command");
    await respondToInvoke(nodeClient, await invokeCapture.waitForInvoke(), nodeId);
    expect((await invokeResP).ok).toBe(true);
  });

  test("rechecks current allowlist before exposing approved live commands", async () => {
    let originalConfig: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
    const reconcileRuntimePolicy = reloadFixture.reconcileRuntimePolicy;
    if (!reconcileRuntimePolicy) {
      throw new Error("gateway runtime policy reconciliation is required");
    }
    const fixture = nodeFixture("node-approve-live-commands-current-allowlist");
    const nodeClient = await connectNodeClientWithPairing(fixture);
    try {
      await expectConnectedCommands(fixture.displayName, []);
      const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
      originalConfig = await readConfigFileSnapshot();
      await fs.writeFile(
        originalConfig.path,
        JSON.stringify({ gateway: { nodes: { commands: { deny: ["canvas.snapshot"] } } } }),
      );
      // The shared minimal Gateway skips file watching; drive its real commit hook.
      await reconcileRuntimePolicy((await readConfigFileSnapshot()).config, "committed");
      await approvePendingNodePairing(nodeId, fixture.commands);
      await expectConnectedCommands(fixture.displayName, []);
      await expectCanvasSnapshotDenied(nodeId, "stale-allowlist-canvas-snapshot");
    } finally {
      await nodeClient.stopAndWait();
      if (originalConfig) {
        await fs.writeFile(originalConfig.path, originalConfig.raw ?? "{}\n");
        await reconcileRuntimePolicy(originalConfig.config, "committed");
      }
    }
  });

  test("records only allowlisted commands in pending node pairing requests", async () => {
    const fixture = nodeFixture("node-pending-allowlisted-only", {
      commands: ["system.run", "canvas.snapshot"],
      platform: "İOS",
      deviceFamily: "iPhone",
    });
    await connectNodeClientWithPairing(fixture);
    const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
    await expectPendingPairingCommands(nodeId, ["canvas.snapshot"]);
  });

  test("rejects reconnect metadata spoof for paired node devices", async () => {
    const fixture = nodeFixture("node-platform-pin", { platform: "ios", deviceFamily: "iPhone" });
    const iosClient = await connectNodeClientWithPairing(fixture);
    await iosClient.stopAndWait();
    await expectConnectedNodeCount(0);
    await expect(
      connectNodeClient({
        ...fixture,
        commands: ["system.run"],
        platform: "linux",
        deviceFamily: "linux",
      }),
    ).rejects.toThrow(/device metadata change pending approval/i);
  });

  test("does not promote paired desktop client id changes into host command defaults", async () => {
    const fixture = nodeFixture("node-client-id-promotion", {
      clientName: GATEWAY_CLIENT_NAMES.MACOS_APP,
    });
    const macClient = await connectNodeClientWithNodePairing(fixture);
    await macClient.stopAndWait();
    for (let attempt = 0; attempt < 2; attempt++) {
      const spoofClient = await connectNodeClient({
        ...fixture,
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        commands: ["system.run"],
      });
      await expectConnectedCommands(fixture.displayName, []);
      await spoofClient.stopAndWait();
    }
  });

  test("allows canonical node-host reconnect for legacy pinned platform metadata", async () => {
    const fixture = nodeFixture("node-host-platform-upgrade", { platform: "darwin" });
    const legacyClient = await connectNodeClientWithPairing(fixture);
    await legacyClient.stopAndWait();
    await expectConnectedNodeCount(0);
    await connectNodeClient({ ...fixture, commands: ["system.run"], platform: "macos" });
    await expect
      .poll(
        async () => (await findConnectedNodeByDisplayName(fixture.displayName))?.connected ?? false,
        FAST_WAIT_OPTS,
      )
      .toBe(true);
    const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
    const pending = await getPendingNodePairing(nodeId);
    expect(pending?.commands).toEqual(["system.run"]);
  });

  test("filters system.run for confusable iOS metadata at connect time", async () => {
    const fixture = nodeFixture("node-greek-omicron-family", {
      commands: ["system.run", "canvas.snapshot"],
      platform: "ios",
      deviceFamily: "iPhοne",
    });
    await connectNodeClientWithNodePairing(fixture);
    await expectConnectedCommands(fixture.displayName, ["canvas.snapshot"], {
      timeout: 2_000,
      interval: 10,
    });
    const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
    const systemRunRes = await rpcReq(ws, "node.invoke", {
      nodeId,
      command: "system.run",
      params: { command: "echo blocked" },
      idempotencyKey: "allowlist-confusable-greek-omicron",
    });
    expect(systemRunRes.ok).toBe(false);
    expect(systemRunRes.error?.message ?? "").toContain("node command not allowed");
  });
});
