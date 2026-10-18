// Tests node-role capability approvals stored on canonical paired-device records.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import type { NodePairingGeneration } from "./device-pairing-identity.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  listNodePairing,
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  recordPairedNodeHostStats,
  releaseNodePairingCleanupClaim,
  renamePairedNode,
  requestNodePairing,
  reusePendingNodePairingForReconnect,
} from "./device-pairing-node.js";
import { seedNodeDevice, setupPairedNode } from "./device-pairing-node.test-support.js";
import {
  getPairedDevice,
  listDevicePairingReadOnly,
  requestDevicePairing,
  resolveNodePairingGeneration,
  withPairedDeviceRecords,
} from "./device-pairing.js";
import {
  NODE_BROWSER_PROXY_COMMANDS,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_TERMINAL_UPLOAD_COMMAND,
} from "./node-commands.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-" });
const databasePaths = new Set<string>();
const hostStats: NodeHostStats = {
  cpuCount: 4,
  loadAverage: [1.5, 1, 0.5],
  memoryTotalBytes: 8192,
  memoryFreeBytes: 4096,
  updatedAtMs: 1_250,
};

let baseDir: string;
beforeEach(async () => {
  baseDir = await tempDirs.make("case");
  databasePaths.add(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: baseDir }),
  );
});

async function findPairedNode() {
  const pairing = await listNodePairing(baseDir);
  return pairing.paired.find((node) => node.nodeId === "node-1") ?? null;
}

function reuseReconnect(
  cleanupClaim: Parameters<typeof reusePendingNodePairingForReconnect>[1],
  displayName?: string,
) {
  return reusePendingNodePairingForReconnect(
    {
      nodeId: "node-1",
      platform: "darwin",
      commands: ["system.run", "canvas.snapshot"],
      ...(displayName ? { displayName } : {}),
    },
    cleanupClaim,
    baseDir,
  );
}

function publishSessionHost(
  expectedPairingGeneration: NodePairingGeneration,
  sessionHost: boolean,
  isConnectionCurrent = () => true,
) {
  return updatePairedNodeSessionHost({
    nodeId: "node-1",
    expectedPairingGeneration,
    sessionHost,
    isConnectionCurrent,
    baseDir,
  });
}

function disconnect(
  expectedPairingGeneration: NodePairingGeneration,
  connectedAtMs: number,
  disconnectedAtMs: number,
) {
  return recordPairedNodeDisconnection({
    nodeId: "node-1",
    expectedPairingGeneration,
    connectedAtMs,
    disconnectedAtMs,
    baseDir,
  });
}

function requestExpandedSurface() {
  return requestNode({ commands: ["system.run", "canvas.snapshot"] });
}

function requestNode(input: Partial<Parameters<typeof requestNodePairing>[0]> = {}) {
  return requestNodePairing({ nodeId: "node-1", platform: "darwin", ...input }, baseDir);
}

function approveNode(requestId: string, callerScopes = ["operator.pairing", "operator.admin"]) {
  return approveNodePairing(requestId, { callerScopes }, baseDir);
}

describe("node surface approvals", () => {
  beforeAll(() => tempDirs.setup());

  afterAll(async () => {
    for (const databasePath of databasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    await tempDirs.cleanup();
  });

  test("requires a paired device before accepting surface requests", async () => {
    await expect(
      requestNodePairing({ nodeId: "node-unpaired", platform: "darwin" }, baseDir),
    ).rejects.toThrow(/paired device/);
  });

  test("reuses pending requests for metadata refreshes", async () => {
    await seedNodeDevice(baseDir, "node-1");
    const first = await requestNode();
    const second = await requestNode();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.requestId).toBe(first.request.requestId);
    expect("revision" in first.request).toBe(false);
    expect("revision" in second.request).toBe(false);

    await seedNodeDevice(baseDir, "node-2");
    const commandFirst = await requestNode({
      nodeId: "node-2",
      commands: ["canvas.snapshot"],
    });

    const commandSecond = await requestNode({
      nodeId: "node-2",
      displayName: "Updated Node",
      commands: ["canvas.snapshot"],
    });

    expect(commandSecond.created).toBe(false);
    expect(commandSecond.superseded).toBeUndefined();
    expect(commandSecond.request.requestId).toBe(commandFirst.request.requestId);
    expect(commandSecond.request.displayName).toBe("Updated Node");
    expect(commandSecond.request.commands).toEqual(["canvas.snapshot"]);

    await seedNodeDevice(baseDir, "node-3");
    const reorderedFirst = await requestNode({
      nodeId: "node-3",
      caps: ["camera", "screen"],
      commands: ["canvas.snapshot", "system.run"],
      permissions: { "caf\u00e9": true, "cafe\u0301": false },
    });
    const reorderedSecond = await requestNode({
      nodeId: "node-3",
      caps: ["screen", "camera"],
      commands: ["system.run", "canvas.snapshot"],
      permissions: { "cafe\u0301": false, "caf\u00e9": true },
    });

    expect(reorderedSecond.created).toBe(false);
    expect(reorderedSecond.superseded).toBeUndefined();
    expect(reorderedSecond.request.requestId).toBe(reorderedFirst.request.requestId);

    await seedNodeDevice(baseDir, "node-4");
    await requestNode({
      nodeId: "node-4",
      commands: ["canvas.present"],
    });

    const pairing = await listNodePairing(baseDir);
    const pendingNode = expectDefined(
      pairing.pending.find((node) => node.nodeId === "node-4"),
      "pending node",
    );
    expect(pendingNode.commands).toEqual(["canvas.present"]);
    expect(pendingNode.requiredApproveScopes).toEqual(["operator.pairing", "operator.write"]);
    expect("revision" in pendingNode).toBe(false);
    expect(pairing.paired).toEqual([]);
  });

  test("supersedes pending requests when the approval surface changes", async () => {
    await seedNodeDevice(baseDir, "node-1");
    const first = await requestNode({
      caps: ["camera"],
      commands: ["canvas.snapshot"],
      permissions: { camera: true },
    });
    const second = await requestNode({
      commands: ["canvas.snapshot", "system.run"],
    });

    expect(second.created).toBe(true);
    expect(second.superseded).toEqual([{ requestId: first.request.requestId, nodeId: "node-1" }]);
    expect(second.request.requestId).not.toBe(first.request.requestId);

    const list = await listNodePairing(baseDir);
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0]?.requestId).toBe(second.request.requestId);
    expect(list.pending[0]?.commands).toEqual(["canvas.snapshot", "system.run"]);

    await expect(approveNode(first.request.requestId)).resolves.toBeNull();

    const approved = await approveNode(second.request.requestId);
    expect(approved).toMatchObject({
      requestId: second.request.requestId,
      node: { commands: ["canvas.snapshot", "system.run"] },
    });

    await seedNodeDevice(baseDir, "node-2");
    const capsFirst = await requestNode({
      nodeId: "node-2",
      caps: ["camera"],
    });
    const capsSecond = await requestNode({
      nodeId: "node-2",
      caps: ["camera", "screen"],
    });
    expect(capsSecond.created).toBe(true);
    expect(capsSecond.superseded).toEqual([
      { requestId: capsFirst.request.requestId, nodeId: "node-2" },
    ]);
    expect(capsSecond.request.requestId).not.toBe(capsFirst.request.requestId);

    await seedNodeDevice(baseDir, "node-3");
    const permissionsFirst = await requestNode({
      nodeId: "node-3",
      permissions: { camera: true },
    });
    const permissionsSecond = await requestNode({
      nodeId: "node-3",
      permissions: { camera: true, screen: true },
    });

    expect(permissionsSecond.created).toBe(true);
    expect(permissionsSecond.superseded).toEqual([
      { requestId: permissionsFirst.request.requestId, nodeId: "node-3" },
    ]);
    expect(permissionsSecond.request.requestId).not.toBe(permissionsFirst.request.requestId);
  });

  test("rejects every pending request for one node without removing its approval", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const snapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(snapshot.cleanupClaim).toBeDefined();

    await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([
      { requestId: pending.request.requestId, nodeId: "node-1" },
    ]);
    await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);

    const pairing = await listNodePairing(baseDir);
    expect(pairing.pending).toEqual([]);
    expect(pairing.paired).toHaveLength(1);
    expect(pairing.paired[0]?.nodeId).toBe("node-1");
    await expect(findPairedNode()).resolves.toMatchObject({
      commands: ["system.run"],
    });
  });

  test("preserves a pending request refreshed after the connect snapshot", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const snapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(snapshot.cleanupClaim).toBeDefined();
    const refreshed = await requestExpandedSurface();
    expect(refreshed.request.requestId).toBe(pending.request.requestId);

    await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
    expect((await listNodePairing(baseDir)).pending).toHaveLength(1);
  });

  test("reuses an unchanged reconnect request without leaving stale cleanup ownership", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const snapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(snapshot.cleanupClaim).toBeDefined();

    await expect(reuseReconnect(snapshot.cleanupClaim)).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
    await expect(approveNode(pending.request.requestId)).resolves.toMatchObject({
      requestId: pending.request.requestId,
    });
  });

  test("claims and reuses a committed reconnect while the pairing writer is occupied", async ({
    signal,
  }) => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const entered = createDeferred();
    const release = createDeferred();
    const writer = withDevicePairingLock(async () => {
      entered.resolve();
      await release.promise;
    });
    let snapshot: Awaited<ReturnType<typeof beginNodePairingConnect>> | undefined;
    try {
      await withinTest(entered.promise, signal);
      snapshot = await withinTest(beginNodePairingConnect("node-1", baseDir), signal);
      expect(snapshot.pairedNode?.commands).toEqual(["system.run"]);
      expect(snapshot.cleanupClaim).toBeDefined();
      await expect(
        withinTest(reuseReconnect(snapshot.cleanupClaim), signal),
      ).resolves.toMatchObject({
        request: { requestId: pending.request.requestId },
        created: false,
      });
    } finally {
      release.resolve();
      await writer;
      if (snapshot?.cleanupClaim) {
        await releaseNodePairingCleanupClaim(snapshot.cleanupClaim);
      }
    }
    await expect(approveNode(pending.request.requestId)).resolves.toMatchObject({
      requestId: pending.request.requestId,
    });
  });

  test("does not reuse a reconnect request when pending metadata changed", async () => {
    await setupPairedNode(baseDir);
    await requestNode({
      displayName: "Old Name",
      commands: ["system.run", "canvas.snapshot"],
    });
    const snapshot = await beginNodePairingConnect("node-1", baseDir);

    await expect(reuseReconnect(snapshot.cleanupClaim, "New Name")).resolves.toBeNull();
    if (snapshot.cleanupClaim) {
      await releaseNodePairingCleanupClaim(snapshot.cleanupClaim);
    }
  });

  test("preserves newer cleanup ownership after an older reconnect reuses pending state", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const matchingReconnect = await beginNodePairingConnect("node-1", baseDir);
    const changedReconnect = await beginNodePairingConnect("node-1", baseDir);
    expect(matchingReconnect.cleanupClaim).toBeDefined();
    expect(changedReconnect.cleanupClaim).toBeDefined();

    await reuseReconnect(matchingReconnect.cleanupClaim);

    await expect(finalizeNodePairingCleanupClaim(changedReconnect.cleanupClaim!)).resolves.toEqual([
      { requestId: pending.request.requestId, nodeId: "node-1" },
    ]);
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
  });

  test("preserves a replacement pending request created after the connect snapshot", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const snapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(snapshot.cleanupClaim).toBeDefined();
    const replacement = await requestNode({
      commands: ["system.run", "canvas.present"],
    });
    expect(replacement.request.requestId).not.toBe(pending.request.requestId);

    await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
    const remaining = (await listNodePairing(baseDir)).pending;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.requestId).toBe(replacement.request.requestId);
  });

  test("blocks approval until a reconnect cleanup claim is released", async () => {
    await setupPairedNode(baseDir);
    const pending = await requestExpandedSurface();
    const firstSnapshot = await beginNodePairingConnect("node-1", baseDir);
    const secondSnapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(firstSnapshot.cleanupClaim).toBeDefined();
    expect(secondSnapshot.cleanupClaim?.generation).toBeGreaterThan(
      firstSnapshot.cleanupClaim!.generation,
    );

    await expect(approveNode(pending.request.requestId)).resolves.toBeNull();

    await releaseNodePairingCleanupClaim(firstSnapshot.cleanupClaim!);
    await expect(approveNode(pending.request.requestId)).resolves.toBeNull();

    await releaseNodePairingCleanupClaim(secondSnapshot.cleanupClaim!);
    await expect(approveNode(pending.request.requestId)).resolves.toMatchObject({
      requestId: pending.request.requestId,
    });
  });

  test.each([
    ...[
      ...NODE_SYSTEM_RUN_COMMANDS,
      ...NODE_BROWSER_PROXY_COMMANDS,
      ...NODE_EXEC_APPROVALS_COMMANDS,
      NODE_FS_LIST_DIR_COMMAND,
      NODE_TERMINAL_UPLOAD_COMMAND,
    ].map((command) => ({ command, scopes: ["operator.pairing", "operator.admin"] })),
    { command: "canvas.present", scopes: ["operator.pairing", "operator.write"] },
    { command: undefined, scopes: ["operator.pairing"] },
  ])("reports and enforces approval scopes for $command", async ({ command, scopes }) => {
    await seedNodeDevice(baseDir, "node-1");
    const commands = command ? [command] : undefined;
    const { request } = await requestNode({ commands });

    expect(request.requiredApproveScopes).toEqual(scopes);
    expect((await listNodePairing(baseDir)).pending).toEqual([request]);
    await expect(
      approveNodePairing(request.requestId, { callerScopes: scopes.slice(0, -1) }, baseDir),
    ).resolves.toEqual({
      status: "forbidden",
      missingScope: scopes.at(-1),
    });
    await expect(findPairedNode()).resolves.toBeNull();

    const approved = await approveNodePairing(request.requestId, { callerScopes: scopes }, baseDir);
    expect(approved).toMatchObject({
      requestId: request.requestId,
      node: { nodeId: "node-1", commands },
    });
  });

  test("updates remote skill bins and reports missing nodes", async () => {
    await withNodePairingDir(async (baseDir) => {
      const generation = await setupPairedNode(baseDir);

      await expect(recordPairedNodeConnection("node-1", 1_234, baseDir)).resolves.toEqual({
        recorded: true,
        firstConnection: true,
      });
      await expect(updatePairedNodeBins("node-1", ["ffmpeg"], generation, baseDir)).resolves.toBe(
        true,
      );
      await expect(updatePairedNodeBins("missing", ["ffmpeg"], generation, baseDir)).resolves.toBe(
        false,
      );

      const pairedNode = await findPairedNode("node-1", baseDir);
      expect(pairedNode?.lastConnectedAtMs).toBe(1_234);
      expect(pairedNode?.bins).toEqual(["ffmpeg"]);
    });
  });

  test("persists exact session-host consent across read-only and reopened readers", async () => {
    const generation = await setupPairedNode(baseDir);
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    const initialVersion = database.db.prepare("PRAGMA user_version").get();

    await expect(publishSessionHost(generation, true)).resolves.toBe(true);
    expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.sessionHost).toBe(true);
    expect(
      (await listDevicePairingReadOnly(baseDir)).paired.find(
        (device) => device.deviceId === "node-1",
      )?.nodeSurface?.sessionHost,
    ).toBe(true);

    expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
    expect((await findPairedNode())?.sessionHost).toBe(true);
    expect(
      openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } })
        .db.prepare("PRAGMA user_version")
        .get(),
    ).toEqual(initialVersion);

    await expect(publishSessionHost(generation, false)).resolves.toBe(true);
    expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.sessionHost).toBe(false);
    expect((await findPairedNode())?.sessionHost).toBeUndefined();
  });

  test("rejects session-host consent after its connection ownership is replaced", async () => {
    const generation = await setupPairedNode(baseDir);
    const snapshotLoaded = createDeferred();
    const releaseMutation = createDeferred();
    const lockedMutation = withPairedDeviceRecords(baseDir, async () => {
      snapshotLoaded.resolve();
      await releaseMutation.promise;
      return { value: undefined, persist: false };
    });
    await snapshotLoaded.promise;

    let connectionCurrent = true;
    const publication = publishSessionHost(generation, true, () => connectionCurrent);
    connectionCurrent = false;
    releaseMutation.resolve();

    await lockedMutation;
    await expect(publication).resolves.toBe(false);
    expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.sessionHost).toBeUndefined();
  });

  test("rejects retired-generation bins after node-surface reapproval", async () => {
    await setupPairedNode(baseDir);
    const previousGeneration = expectDefined(
      resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
      "expected previous node pairing generation",
    );
    await expect(
      updatePairedNodeBins("node-1", ["retired-bin"], previousGeneration, baseDir),
    ).resolves.toBe(true);
    await expect(publishSessionHost(previousGeneration, true)).resolves.toBe(true);

    const pending = await requestNode({ commands: ["system.run", "system.which"] });
    await approveNode(pending.request.requestId);

    const currentGeneration = expectDefined(
      resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
      "expected current node pairing generation",
    );
    expect(currentGeneration.key).not.toBe(previousGeneration.key);
    expect((await findPairedNode())?.bins).toBeUndefined();
    expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.sessionHost).toBeUndefined();
    await expect(publishSessionHost(previousGeneration, true)).resolves.toBe(false);
    await expect(
      updatePairedNodeBins("node-1", ["stale-write"], previousGeneration, baseDir),
    ).resolves.toBe(false);
    await expect(
      updatePairedNodeBins("node-1", ["current-bin"], currentGeneration, baseDir),
    ).resolves.toBe(true);
    expect((await findPairedNode())?.bins).toEqual(["current-bin"]);
  });

  test("atomically grants one first-connection claim across concurrent handshakes", async () => {
    await setupPairedNode(baseDir);

    const claims = await Promise.all([
      recordPairedNodeConnection("node-1", 1_000, baseDir),
      recordPairedNodeConnection("node-1", 2_000, baseDir),
    ]);

    expect(claims.filter((claim) => claim.recorded && claim.firstConnection)).toHaveLength(1);
    expect(claims.every((claim) => claim.recorded)).toBe(true);
    expect((await findPairedNode())?.lastConnectedAtMs).toBe(2_000);
    await expect(recordPairedNodeConnection("node-1", 1_500, baseDir)).resolves.toEqual({
      recorded: true,
      firstConnection: false,
    });
    expect((await findPairedNode())?.lastConnectedAtMs).toBe(2_000);
    await expect(recordPairedNodeConnection("node-1", 3_000, baseDir)).resolves.toEqual({
      recorded: true,
      firstConnection: false,
    });
    await expect(recordPairedNodeConnection("missing", 4_000, baseDir)).resolves.toEqual({
      recorded: false,
    });
    expect((await findPairedNode())?.lastConnectedAtMs).toBe(3_000);
  });

  test("records and clears generation-bound node disconnect history", async () => {
    const generation = await setupPairedNode(baseDir);

    await expect(recordPairedNodeConnection("node-1", 1_000, baseDir, generation)).resolves.toEqual(
      { recorded: true, firstConnection: true },
    );
    await expect(disconnect(generation, 1_000, 1_500)).resolves.toEqual({ recorded: true });
    expect(await findPairedNode()).toMatchObject({
      lastConnectedAtMs: 1_000,
      lastDisconnectedAtMs: 1_500,
    });

    await expect(recordPairedNodeConnection("node-1", 2_000, baseDir, generation)).resolves.toEqual(
      { recorded: true, firstConnection: false },
    );
    expect((await findPairedNode())?.lastDisconnectedAtMs).toBeUndefined();
    await expect(disconnect(generation, 1_000, 2_500)).resolves.toEqual({ recorded: false });
    expect((await findPairedNode())?.lastDisconnectedAtMs).toBeUndefined();
    await disconnect(generation, 2_000, 3_000);
    expect((await findPairedNode())?.lastDisconnectedAtMs).toBe(3_000);
  });

  test("persists received host stats across connections and reopened readers", async () => {
    await withNodePairingDir(async (baseDir) => {
      const generation = await setupPairedNode(baseDir);
      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
      });
      await expect(
        recordPairedNodeHostStats({
          nodeId: "node-1",
          hostStats,
          expectedPairingGeneration: generation,
          baseDir,
        }),
      ).resolves.toBe(true);
      expect(await closeOpenClawStateDatabaseByPathAsync(database.path)).toBe(true);
      expect((await getPairedDevice("node-1", baseDir))?.nodeSurface?.lastHostStats).toEqual(
        hostStats,
      );
      expect((await findPairedNode("node-1", baseDir))?.lastHostStats).toEqual(hostStats);
      await recordPairedNodeConnection("node-1", 4_000, baseDir, generation);
      const nextStats = {
        cpuCount: 8,
        memoryTotalBytes: 16384,
        memoryFreeBytes: 0,
        updatedAtMs: 4_500,
      };
      await expect(
        recordPairedNodeHostStats({
          nodeId: "node-1",
          expectedPairingGeneration: generation,
          hostStats: nextStats,
          baseDir,
        }),
      ).resolves.toBe(true);
      expect((await findPairedNode("node-1", baseDir))?.lastHostStats).toEqual(nextStats);
    });
  });

  test.each([
    ["null", null],
    ["missing timestamp", { ...hostStats, updatedAtMs: undefined }],
    ["invalid timestamp", { ...hostStats, updatedAtMs: -1 }],
    ["invalid load", { ...hostStats, loadAverage: ["bad", 0, 0] }],
    ["inconsistent memory", { ...hostStats, memoryFreeBytes: 16384 }],
    ["unpaired disk capacity", { ...hostStats, diskTotalBytes: 1024 }],
  ])("drops stored host stats with %s on read", async (_label, malformed) => {
    await setupPairedNode(baseDir);
    await withPairedDeviceRecords(baseDir, (devices) => {
      Object.assign(devices["node-1"]!.nodeSurface!, { lastHostStats: malformed });
      return { value: undefined, persist: true };
    });
    expect((await getPairedDevice("node-1", baseDir))?.nodeSurface).not.toHaveProperty(
      "lastHostStats",
    );
    expect((await findPairedNode())?.lastHostStats).toBeUndefined();
  });

  test("rejects disconnect history and host stats from a retired pairing generation", async () => {
    const previousGeneration = await setupPairedNode(baseDir);
    await recordPairedNodeConnection("node-1", 1_000, baseDir, previousGeneration);
    const pending = await requestNode({ commands: ["system.run", "system.which"] });
    await approveNode(pending.request.requestId);

    await expect(disconnect(previousGeneration, 1_000, 1_500)).resolves.toEqual({
      recorded: false,
    });
    expect((await findPairedNode())?.lastDisconnectedAtMs).toBeUndefined();
    await expect(
      recordPairedNodeHostStats({
        nodeId: "node-1",
        hostStats,
        expectedPairingGeneration: previousGeneration,
        baseDir,
      }),
    ).resolves.toBe(false);
    expect((await findPairedNode())?.lastHostStats).toBeUndefined();
  });

  test("serializes connection metadata with locked node-surface mutations", async () => {
    await setupPairedNode(baseDir);

    const snapshotLoaded = createDeferred();
    const releaseMutation = createDeferred();
    const lockedMutation = withPairedDeviceRecords(baseDir, async (pairedByDeviceId) => {
      const device = pairedByDeviceId["node-1"];
      if (!device?.nodeSurface) {
        throw new Error("expected paired node surface");
      }
      device.nodeSurface = { ...device.nodeSurface, bins: ["ffmpeg"] };
      snapshotLoaded.resolve();
      await releaseMutation.promise;
      return { value: true, persist: true };
    });
    await snapshotLoaded.promise;

    let connectionSettled = false;
    const connection = recordPairedNodeConnection("node-1", 1_234, baseDir).then((result) => {
      connectionSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(connectionSettled).toBe(false);

    releaseMutation.resolve();
    await expect(lockedMutation).resolves.toBe(true);
    await expect(connection).resolves.toEqual({ recorded: true, firstConnection: true });
    expect(await findPairedNode()).toMatchObject({
      bins: ["ffmpeg"],
      lastConnectedAtMs: 1_234,
    });
  });

  test("rejects connection metadata from a retired pairing generation", async () => {
    const previousGeneration = await setupPairedNode(baseDir);

    const pending = await requestExpandedSurface();
    await approveNode(pending.request.requestId, [
      "operator.pairing",
      "operator.admin",
      "operator.write",
    ]);
    const currentGeneration = expectDefined(
      resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
      "expected replacement node pairing generation",
    );
    expect(currentGeneration.key).not.toBe(previousGeneration.key);

    await expect(
      recordPairedNodeConnection("node-1", 1_000, baseDir, previousGeneration),
    ).resolves.toEqual({ recorded: false });
    expect((await findPairedNode())?.lastConnectedAtMs).toBeUndefined();

    await expect(
      recordPairedNodeConnection("node-1", 2_000, baseDir, currentGeneration),
    ).resolves.toEqual({ recorded: true, firstConnection: true });
    expect((await findPairedNode())?.lastConnectedAtMs).toBe(2_000);
  });

  test("keeps the approved node surface across a device pairing re-approval", async () => {
    await setupPairedNode(baseDir);
    const pendingSurface = await requestExpandedSurface();

    // A device repair (same id, fresh keypair) rebuilds the paired record;
    // approved and pending node surfaces must survive that rebuild.
    const repair = await requestDevicePairing(
      {
        deviceId: "node-1",
        publicKey: "fake",
        role: "node",
        roles: ["node"],
        scopes: [],
      },
      baseDir,
    );
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const paired = await findPairedNode();
    expect(paired?.commands).toEqual(["system.run"]);
    const pending = (await listNodePairing(baseDir)).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe(pendingSurface.request.requestId);
  });

  test("keeps the operator-facing node name through capability reapproval", async () => {
    await setupPairedNode(baseDir, "Reported iPad");
    const initialGeneration = expectDefined(
      resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
      "expected initial node pairing generation",
    );
    const upgrade = await requestNode({
      displayName: "Reported iPad (updated)",
      commands: ["system.run", "canvas.snapshot"],
    });
    expect(upgrade.request.displayName).toBe("Reported iPad (updated)");

    const renamed = await renamePairedNode("node-1", "Living Room iPad", baseDir);
    expect(renamed?.displayName).toBe("Living Room iPad");
    await expect(renamePairedNode("missing", "Nope", baseDir)).resolves.toBeNull();

    await expect(
      approveNode(upgrade.request.requestId, [
        "operator.pairing",
        "operator.admin",
        "operator.write",
      ]),
    ).resolves.toMatchObject({
      node: {
        displayName: "Living Room iPad",
        commands: ["system.run", "canvas.snapshot"],
      },
    });

    const pairedNode = await findPairedNode();
    expect(pairedNode?.displayName).toBe("Living Room iPad");
    expect(pairedNode?.commands).toEqual(["system.run", "canvas.snapshot"]);
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
    expect(resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir))?.key).not.toBe(
      initialGeneration.key,
    );
  });
});
