import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { migrateLegacyDevicePairingStore as migrate } from "./device-pairing-migration.js";
import { seedNodeDevice } from "./device-pairing-node.test-support.js";
import {
  legacyNodeDevice as legacyDevice,
  pairingTimestamps as timestamps,
} from "./device-pairing-state.test-support.js";
import { getPairedDevice as getDevice, listDevicePairing } from "./device-pairing.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";

const suiteRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-device-pairing-migration-",
});

let baseDir: string;
beforeAll(() => suiteRootTracker.setup());
beforeEach(async () => {
  baseDir = await suiteRootTracker.make("case");
});

afterAll(async () => {
  await closeStateDatabaseForTest();
  await suiteRootTracker.cleanup();
});

async function writeLegacyFiles(
  files: { paired?: Record<string, unknown>; pending?: unknown; bootstrap?: unknown },
  kind = "devices",
): Promise<string> {
  const devicesDir = path.join(baseDir, kind);
  await fs.mkdir(devicesDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(devicesDir, `${name}.json`), JSON.stringify(value));
  }
  return devicesDir;
}

async function expectMigration(imported: number, skippedExisting = 0) {
  expect(await migrate({ baseDir })).toEqual({ imported, skippedExisting });
}

async function listDeviceFiles(devicesDir: string): Promise<string[]> {
  return (await fs.readdir(devicesDir)).toSorted();
}

test("imports usable legacy rows, omits invalid fields, and archives all legacy files", async () => {
  const nodeSurface = { displayName: "Living Room iPad", caps: ["camera"], ...timestamps };
  const devicesDir = await writeLegacyFiles({
    paired: {
      "device-a": legacyDevice("device-a", { nodeSurface }),
      "device-b": legacyDevice("device-b"),
      "request-a": {
        requestId: "request-a",
        deviceId: "device-a",
        publicKey: "pk-device-a",
        ts: 1,
      },
      "bad-time": legacyDevice("bad-time", { createdAtMs: 1e100 }),
      "bad-seen": legacyDevice("bad-seen", { lastSeenAtMs: 1e100 }),
      "bad-text": { ...legacyDevice("bad-text"), displayName: { value: "Device" } },
    },
    pending: { "req-1": { requestId: "req-1", deviceId: "device-c", ts: Date.now() } },
    bootstrap: { token: { token: "tok", ts: Date.now(), issuedAtMs: Date.now() } },
  });

  const warnings: string[] = [];
  expect(
    await migrate({
      baseDir,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    }),
  ).toEqual({ imported: 4, skippedExisting: 0 });

  const imported = await getDevice("device-a", baseDir);
  expect(imported).toMatchObject({
    deviceId: "device-a",
    publicKey: "pk-device-a",
    approvedVia: "owner",
    nodeSurface,
    tokens: { node: { token: "legacy-device-a" } },
  });

  expect((await listDevicePairing(baseDir)).pending).toEqual([]);
  const normalizedLastSeen = await getDevice("bad-seen", baseDir);
  expect(normalizedLastSeen?.publicKey).toBe("pk-bad-seen");
  expect(normalizedLastSeen?.lastSeenAtMs).toBeUndefined();
  const normalizedText = await getDevice("bad-text", baseDir);
  expect(normalizedText?.publicKey).toBe("pk-bad-text");
  expect(normalizedText?.displayName).toBeUndefined();
  expect(warnings).toEqual([
    "device pairing store migration skipped 2 invalid paired record(s)",
    "device pairing store migration omitted 2 invalid optional field(s)",
  ]);

  expect(await listDeviceFiles(devicesDir)).toEqual([
    "bootstrap.json.migrated",
    "paired.json.migrated",
    "pending.json.migrated",
  ]);

  expect(await migrate({ baseDir })).toBeNull();
});

test("keeps existing SQLite records over legacy rows for the same device id", async () => {
  await seedNodeDevice(baseDir, "device-a");
  await writeLegacyFiles({ paired: { "device-a": legacyDevice("device-a") } });

  await expectMigration(0, 1);
  expect((await getDevice("device-a", baseDir))?.publicKey).toBe("test-key-device-a");
});

test("throws on an unreadable paired store and leaves the files in place", async () => {
  const devicesDir = path.join(baseDir, "devices");
  await fs.mkdir(devicesDir, { recursive: true });
  await fs.writeFile(path.join(devicesDir, "paired.json"), "{not-json}");

  await expect(migrate({ baseDir })).rejects.toThrow();
  expect(await listDeviceFiles(devicesDir)).toEqual(["paired.json"]);
});

test("archives transient-only legacy files without importing anything", async () => {
  const devicesDir = await writeLegacyFiles({ pending: {}, bootstrap: {} });

  await expectMigration(0);
  expect(await listDeviceFiles(devicesDir)).toEqual([
    "bootstrap.json.migrated",
    "pending.json.migrated",
  ]);
});

test("device import before node fold lets legacy node surfaces land on imported records", async () => {
  const surface = { displayName: "Kitchen Display", caps: ["screen"] };
  await writeLegacyFiles({
    paired: { "device-a": legacyDevice("device-a") },
  });
  await writeLegacyFiles(
    {
      paired: {
        "device-a": {
          nodeId: "device-a",
          ...surface,
          ...timestamps,
        },
      },
    },
    "nodes",
  );

  await migrate({ baseDir });
  const folded = await migrateLegacyNodePairingStore({ baseDir });
  expect(folded).toEqual({ migrated: 1, orphaned: 0 });
  expect((await getDevice("device-a", baseDir))?.nodeSurface).toMatchObject(surface);
});
