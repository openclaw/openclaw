import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../infra/supervisor-markers.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
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
      readonlyPreparation.prepared.push({ pathname, location: prepared?.location, progressed });
  };
  const track =
    <Args extends [string, ...unknown[]], Prepared extends { location: string }, Result>(
      prepare: (...args: Args) => Result,
      location: (result: Result) => Prepared | Promise<Prepared>,
    ) =>
    (...args: Args) => {
      const finish = observe(args[0]);
      try {
        const result = prepare(...args);
        const prepared = location(result);
        if (prepared instanceof Promise) {
          void prepared.then(finish, () => finish());
        } else {
          finish(prepared);
        }
        return result;
      } catch (error) {
        finish();
        throw error;
      }
    };
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: track(actual.prepareSqliteReadOnlyLocationSync, (p) => p),
    prepareSqliteReadOnlyLocation: track(actual.prepareSqliteReadOnlyLocation, (p) => p),
    startSqliteReadOnlyLocationAsync: track(
      actual.startSqliteReadOnlyLocationAsync,
      (p) => p.result,
    ),
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

let ws: WebSocket;
let port: number;

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

beforeEach(installCanvasNodePolicyForTest);

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

type NodeFixture = Pick<
  Parameters<typeof connectGatewayClient>[0],
  "platform" | "deviceFamily" | "deviceIdentity" | "clientName" | "onEvent"
> & {
  displayName: string;
  commands: string[];
};
const connectNodeClient = async ({ displayName, ...params }: NodeFixture) => {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error("OPENCLAW_GATEWAY_TOKEN is required for node test clients");
  }
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    role: "node",
    ...params,
    clientName: params.clientName ?? GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientVersion: "1.0.0",
    clientDisplayName: displayName,
    platform: params.platform ?? "ios",
    mode: GATEWAY_CLIENT_MODES.NODE,
    instanceId: displayName,
    scopes: [],
    timeoutMessage: "timeout waiting for node to connect",
  });
  nodeClients.push(client);
  return client;
};

const connectNodeClientWithPairing = async (params: NodeFixture) => {
  try {
    return await connectNodeClient(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("pairing required")) {
      throw error;
    }
    for (const pending of (await listDevicePairing()).pending) {
      await approveDevicePairing(pending.requestId, {
        callerScopes: pending.scopes ?? ["operator.admin"],
      });
    }
    return await connectNodeClient(params);
  }
};

const connectNodeClientWithNodePairing = async (params: NodeFixture) => {
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

async function connectedNodes() {
  const result = await rpcReq<{
    nodes?: { nodeId: string; displayName?: string; connected?: boolean; commands?: string[] }[];
  }>(ws, "node.list", {});
  return result.payload?.nodes?.filter((node) => node.connected) ?? [];
}

async function findConnectedNodeByDisplayName(displayName: string) {
  return (await connectedNodes()).find((node) => node.displayName === displayName);
}

async function findConnectedNodeIdByDisplayName(displayName: string) {
  const node = await findConnectedNodeByDisplayName(displayName);
  if (!node?.nodeId) {
    throw new Error(`expected connected node id for ${displayName}`);
  }
  return node.nodeId;
}

async function expectConnectedCommands(
  displayName: string,
  commands: string[],
  opts: { timeout: number; interval: number } = FAST_WAIT_OPTS,
) {
  await expect
    .poll(async () => {
      return (await findConnectedNodeByDisplayName(displayName))?.commands?.toSorted() ?? [];
    }, opts)
    .toEqual(commands);
}

async function expectConnectedNodeCount(count: number) {
  await expect.poll(async () => (await connectedNodes()).length, FAST_WAIT_OPTS).toBe(count);
}

async function expectPendingPairingCommands(nodeId: string, commands: string[]) {
  expect(await getPendingNodePairing(nodeId)).toMatchObject({ nodeId, commands });
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

async function invokeCanvasSnapshot(
  nodeId: string,
  idempotencyKey: string,
  params: { format?: string } = { format: "png" },
) {
  return rpcReq<{ payload?: unknown; payloadJSON?: string | null }>(ws, "node.invoke", {
    nodeId,
    command: "canvas.snapshot",
    params,
    idempotencyKey,
  });
}

async function expectCanvasSnapshotDenied(
  nodeId: string,
  idempotencyKey: string,
  params?: { format?: string },
) {
  expect(await invokeCanvasSnapshot(nodeId, idempotencyKey, params)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("node command not allowed") },
  });
}

function createInvokeCapture() {
  type Payload = { id?: string; nodeId?: string };
  let waiting: ReturnType<typeof Promise.withResolvers<Payload>> | undefined;
  const pendingPayloads: Payload[] = [];
  return {
    waitForInvoke: () => {
      const pending = pendingPayloads.shift();
      if (pending) {
        return Promise.resolve(pending);
      }
      if (waiting) {
        throw new Error("already waiting for a node invoke request");
      }
      waiting = Promise.withResolvers<Payload>();
      return waiting.promise;
    },
    onEvent: (evt: { event?: string; payload?: unknown }) => {
      if (evt.event === "node.invoke.request") {
        const payload = evt.payload as Payload;
        if (waiting) {
          waiting.resolve(payload);
          waiting = undefined;
        } else {
          pendingPayloads.push(payload);
        }
      }
    },
  };
}

async function respondToInvoke(
  client: GatewayClient,
  payload: { id?: string; nodeId?: string },
  fallbackNodeId: string,
) {
  await client.request("node.invoke.result", {
    id: payload.id ?? "",
    nodeId: payload.nodeId ?? fallbackNodeId,
    ok: true,
    payloadJSON: JSON.stringify({ ok: true }),
  });
}

test("gateway enforces operator and node permissions", async () => {
  for (const [method, params] of [
    ["node.event", { event: "test", payload: { ok: true } }],
    ["node.invoke.result", { id: "invoke-1", nodeId: "node-1", ok: true }],
  ] as const) {
    expect(await rpcReq(ws, method, params)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("unauthorized role") },
    });
  }

  const nodeClient = await connectNodeClientWithNodePairing({
    commands: [],
    displayName: "node-role-enforcement",
  });

  const event = "test.unsupported";
  expect(await nodeClient.request("node.event", { event, payload: { ok: true } })).toEqual({
    ok: true,
    event,
    handled: false,
    reason: "unsupported_event",
  });

  const binsPayload = await nodeClient.request("skills.bins", {});
  expect(Array.isArray(binsPayload?.bins)).toBe(true);

  await expect(nodeClient.request("status", {})).rejects.toThrow("unauthorized role");

  expect((await nodeClient.request<HealthSummary>("health", {})).ok).toBe(true);
});

registerGatewayUpdateHistoryTests(() => port, readonlyPreparation);

test("update.run persists the accepted handoff before parking and restarting its foreground owner", async () => {
  await withEnvAsync(
    Object.fromEntries(SUPERVISOR_HINT_ENV_VARS.map((key) => [key, undefined])),
    async () => {
      const [installStatus, gatewayOwner, handoff, restart] = await Promise.all([
        import("../infra/update-install-status.js"),
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
      const foregroundOrigin = { owner: "role-update-owner", pid: process.pid, startedAt, port };
      const installation = vi
        .spyOn(installStatus, "resolveStartupInstallStatus")
        .mockResolvedValue({
          root,
          status: { root, installKind: "git", packageManager: "pnpm" },
          installReceipt: null,
        });
      // The shared server starts below the CLI run loop that publishes its owner.
      const readOwner = vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
        ...foregroundOrigin,
        host: os.hostname(),
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
        expect(res).toMatchObject({
          ok: true,
          payload: { ok: true, sentinel: { persisted: true }, handoff: { status: "started" } },
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
          foregroundOrigin,
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
        for (const spy of [schedule, claim, transfer, start, readOwner, installation]) {
          spy.mockRestore();
        }
      }
    },
  );
});

async function connectPendingNode(fixture: NodeFixture) {
  await writeConfigFile({ gateway: { nodes: { pairing: { autoApproveLocal: false } } } });
  const client = await connectNodeClientWithPairing(fixture);
  return { client, nodeId: await findConnectedNodeIdByDisplayName(fixture.displayName) };
}

function nodeFixture(displayName: string, options: Partial<Omit<NodeFixture, "displayName">> = {}) {
  return {
    displayName,
    commands: ["canvas.snapshot"],
    platform: "macos",
    deviceFamily: "Mac",
    deviceIdentity: loadOrCreateDeviceIdentity({
      path: path.join(
        os.tmpdir(),
        `${displayName}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
      ),
    }),
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
    await expectCanvasSnapshotDenied(emptyNodeId, "allowlist-2", {});
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
      const invokeResult = invokeCanvasSnapshot(allowedNodeId, `allowlist-${id}-payloadjson`);
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
    const { client: nodeClient, nodeId } = await connectPendingNode(fixture);
    await expectConnectedCommands(fixture.displayName, []);
    await expectPendingPairingCommands(nodeId, fixture.commands);
    expect(await invokeCanvasSnapshot(nodeId, "pending-node-canvas")).toMatchObject({
      ok: false,
      error: { details: { code: "PAIRING_CHANGED" } },
    });

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
    const { client: nodeClient, nodeId } = await connectPendingNode(fixture);
    try {
      await expectConnectedCommands(fixture.displayName, []);
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
    const { nodeId } = await connectPendingNode(fixture);
    await expectPendingPairingCommands(nodeId, ["canvas.snapshot"]);
  });

  test.each([
    ["metadata spoof", "ios", "iPhone", "linux", true],
    ["legacy platform normalization", "darwin", "Mac", "macos", false],
  ] as const)(
    "%s on a paired node reconnect",
    async (_name, platform, deviceFamily, next, rejects) => {
      const fixture = nodeFixture("node-platform-reconnect", { platform, deviceFamily });
      const client = await connectNodeClientWithPairing(fixture);
      await client.stopAndWait();
      await expectConnectedNodeCount(0);
      const reconnect = connectNodeClient({
        ...fixture,
        commands: ["system.run"],
        platform: next,
        deviceFamily: rejects ? "linux" : fixture.deviceFamily,
      });
      if (rejects) {
        await expect(reconnect).rejects.toThrow(/device metadata change pending approval/i);
      } else {
        await reconnect;
        await expect
          .poll(
            async () =>
              (await findConnectedNodeByDisplayName(fixture.displayName))?.connected ?? false,
            FAST_WAIT_OPTS,
          )
          .toBe(true);
        const nodeId = await findConnectedNodeIdByDisplayName(fixture.displayName);
        expect((await getPendingNodePairing(nodeId))?.commands).toEqual(["system.run"]);
      }
    },
  );

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
