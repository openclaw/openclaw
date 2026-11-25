import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  approveNodePairing,
  listNodePairing,
  recordPairedNodeConnection,
  requestNodePairing,
} from "./device-pairing-node.js";
import { seedNodeDevice } from "./device-pairing-node.test-support.js";
import { usePairingState } from "./device-pairing-state.test-support.js";
import { getPairedDevice } from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import { resolvePairingPaths } from "./pairing-files.js";

const state = usePairingState("openclaw-node-pairing-migration-");

const deviceId = "canonical-node";
async function fixture() {
  const { baseDir } = state;
  await seedNodeDevice(baseDir, deviceId);
  const paths = resolvePairingPaths(baseDir, "nodes");
  return {
    ...paths,
    migrate: () => migrateLegacyNodePairingStore({ baseDir }),
    read: () => getPairedDevice(deviceId, baseDir),
    list: () => listNodePairing(baseDir),
    approve: async (surface: Omit<Parameters<typeof requestNodePairing>[0], "nodeId">) => {
      const pending = await requestNodePairing({ ...surface, nodeId: deviceId }, baseDir);
      return approveNodePairing(pending.request.requestId, { callerScopes }, baseDir);
    },
    record: (nodeId: string, time: number) => recordPairedNodeConnection(nodeId, time, baseDir),
  };
}

const callerScopes = ["operator.pairing", "operator.write"];
const legacyRow = (nodeId: string) => ({ nodeId, createdAtMs: 1_000, approvedAtMs: 2_000 });

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("folds legacy rows into device records, drops orphans, and archives files", async () => {
  const { migrate, read, list, pendingPath, pairedPath } = await fixture();
  const surface = {
    displayName: "Living Room iPad",
    caps: ["canvas", "screen"],
    commands: ["screen.snapshot", "system.run"],
  };
  await writeJson(pairedPath, {
    [deviceId]: {
      ...legacyRow(deviceId),
      token: "retired-token",
      ...surface,
    },
    "node-orphaned": legacyRow("node-orphaned"),
  });
  await writeJson(pendingPath, {
    "req-1": { requestId: "req-1", nodeId: deviceId, ts: Date.now() },
  });

  await expect(migrate()).resolves.toEqual({ migrated: 1, orphaned: 1 });
  const device = await read();
  expect(device?.nodeSurface).toMatchObject(surface);
  expect(JSON.stringify(device)).not.toContain("retired-token");
  expect((await list()).paired.map((node) => node.nodeId)).toEqual([deviceId]);
  await expect(fs.access(pairedPath)).rejects.toThrow();
  await fs.access(`${pairedPath}.migrated`);
  await fs.access(`${pendingPath}.migrated`);
  await expect(migrate()).resolves.toBeNull();
});

test("keeps an existing device surface over stale legacy rows", async () => {
  const { migrate, read, approve, pairedPath } = await fixture();
  await approve({ caps: ["screen"], commands: ["screen.snapshot"] });
  await writeJson(pairedPath, {
    [deviceId]: {
      ...legacyRow(deviceId),
      createdAtMs: 1,
      approvedAtMs: 2,
      caps: ["stale-cap"],
      commands: ["stale.command"],
    },
  });

  await expect(migrate()).resolves.toEqual({ migrated: 0, orphaned: 0 });
  expect((await read())?.nodeSurface?.caps).toEqual(["screen"]);
});

test("drops legacy client-instance aliases and reapproves the canonical device id", async () => {
  const { migrate, approve, record, pairedPath } = await fixture();
  await writeJson(pairedPath, {
    "legacy-client-instance-id": {
      ...legacyRow("legacy-client-instance-id"),
      commands: ["system.notify"],
      lastConnectedAtMs: 3_000,
    },
  });

  await expect(migrate()).resolves.toEqual({ migrated: 0, orphaned: 1 });
  await expect(record("legacy-client-instance-id", 4_000)).resolves.toEqual({ recorded: false });

  await expect(approve({ commands: ["system.notify"] })).resolves.toMatchObject({
    node: { nodeId: deviceId },
  });
  await expect(record(deviceId, 4_000)).resolves.toEqual({ recorded: true, firstConnection: true });
  await expect(record(deviceId, 5_000)).resolves.toEqual({
    recorded: true,
    firstConnection: false,
  });
});
