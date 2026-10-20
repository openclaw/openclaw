// Covers the one-time fold of the legacy nodes/*.json store into device records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  recordPairedNodeConnection,
  requestNodePairing,
} from "./device-pairing-node.js";
import { getPairedDevice, requestDevicePairing } from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import { resolvePairingPaths } from "./pairing-files.js";

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-migration-" });

async function fixture(deviceId: string) {
  const baseDir = await suiteRootTracker.make("case");
  const request = await requestDevicePairing(
    { deviceId, publicKey: `pk-${deviceId}`, role: "node", roles: ["node"], scopes: [] },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
  const paths = resolvePairingPaths(baseDir, "nodes");
  return { baseDir, ...paths };
}

const callerScopes = ["operator.pairing", "operator.write"];
const legacyRow = (nodeId: string) => ({ nodeId, createdAtMs: 1_000, approvedAtMs: 2_000 });

async function approveSurface(
  baseDir: string,
  nodeId: string,
  surface: Omit<Parameters<typeof requestNodePairing>[0], "nodeId">,
) {
  const pending = await requestNodePairing({ ...surface, nodeId }, baseDir);
  return approveNodePairing(pending.request.requestId, { callerScopes }, baseDir);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("migrateLegacyNodePairingStore", () => {
  beforeAll(() => suiteRootTracker.setup());

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("folds legacy rows into device records, drops orphans, and archives files", async () => {
    const { baseDir, pendingPath, pairedPath } = await fixture("node-kept");
    await writeJson(pairedPath, {
      "node-kept": {
        ...legacyRow("node-kept"),
        token: "retired-token",
        displayName: "Living Room iPad",
        caps: ["canvas", "screen"],
        commands: ["screen.snapshot", "system.run"],
      },
      "node-orphaned": {
        ...legacyRow("node-orphaned"),
        token: "orphaned-token",
      },
    });
    await writeJson(pendingPath, {
      "req-1": { requestId: "req-1", nodeId: "node-kept", ts: Date.now() },
    });

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 1,
      orphaned: 1,
    });
    const device = await getPairedDevice("node-kept", baseDir);
    expect(device?.nodeSurface).toMatchObject({
      displayName: "Living Room iPad",
      caps: ["canvas", "screen"],
      commands: ["screen.snapshot", "system.run"],
    });
    expect(JSON.stringify(device)).not.toContain("retired-token");
    expect((await listNodePairing(baseDir)).paired.map((node) => node.nodeId)).toEqual([
      "node-kept",
    ]);
    await expect(fs.access(pairedPath)).rejects.toThrow();
    await fs.access(`${pairedPath}.migrated`);
    await fs.access(`${pendingPath}.migrated`);
    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toBeNull();
  });

  test("keeps an existing device surface over stale legacy rows", async () => {
    const { baseDir, pairedPath } = await fixture("node-current");
    await approveSurface(baseDir, "node-current", {
      caps: ["screen"],
      commands: ["screen.snapshot"],
    });
    await writeJson(pairedPath, {
      "node-current": {
        ...legacyRow("node-current"),
        createdAtMs: 1,
        approvedAtMs: 2,
        caps: ["stale-cap"],
        commands: ["stale.command"],
      },
    });

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 0,
      orphaned: 0,
    });
    expect((await getPairedDevice("node-current", baseDir))?.nodeSurface?.caps).toEqual(["screen"]);
  });

  test("drops legacy client-instance aliases and reapproves the canonical device id", async () => {
    const { baseDir, pairedPath } = await fixture("canonical-device-id");
    await writeJson(pairedPath, {
      "legacy-client-instance-id": {
        ...legacyRow("legacy-client-instance-id"),
        commands: ["system.notify"],
        lastConnectedAtMs: 3_000,
      },
    });

    await expect(migrateLegacyNodePairingStore({ baseDir })).resolves.toEqual({
      migrated: 0,
      orphaned: 1,
    });
    await expect(
      recordPairedNodeConnection("legacy-client-instance-id", 4_000, baseDir),
    ).resolves.toEqual({
      recorded: false,
    });

    await expect(
      approveSurface(baseDir, "canonical-device-id", { commands: ["system.notify"] }),
    ).resolves.toMatchObject({ node: { nodeId: "canonical-device-id" } });
    await expect(
      recordPairedNodeConnection("canonical-device-id", 4_000, baseDir),
    ).resolves.toEqual({
      recorded: true,
      firstConnection: true,
    });
    await expect(
      recordPairedNodeConnection("canonical-device-id", 5_000, baseDir),
    ).resolves.toEqual({
      recorded: true,
      firstConnection: false,
    });
  });
});
