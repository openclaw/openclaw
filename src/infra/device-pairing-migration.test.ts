// Covers the one-time devices/*.json → SQLite pairing store import.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { migrateLegacyDevicePairingStore } from "./device-pairing-migration.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
  type PairedDevice,
} from "./device-pairing.js";
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

function legacyPairedDevice(deviceId: string, extra: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId,
    publicKey: `pk-${deviceId}`,
    displayName: `Device ${deviceId}`,
    clientId: "openclaw-ios",
    clientMode: "node",
    role: "node",
    roles: ["node"],
    scopes: [],
    approvedScopes: [],
    tokens: {
      node: {
        token: ["legacy", deviceId].join("-"),
        role: "node",
        scopes: [],
        createdAtMs: 1_700_000_000_000,
      },
    },
    approvedVia: "owner",
    createdAtMs: 1_700_000_000_000,
    approvedAtMs: 1_700_000_000_000,
    ...extra,
  };
}

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
  expect(await migrateLegacyDevicePairingStore({ baseDir })).toEqual({ imported, skippedExisting });
}

async function listDeviceFiles(devicesDir: string): Promise<string[]> {
  return (await fs.readdir(devicesDir)).toSorted();
}

describe("migrateLegacyDevicePairingStore", () => {
  test("imports legacy paired records and archives all legacy files", async () => {
    const nodeSurface = {
      displayName: "Living Room iPad",
      caps: ["camera"],
      createdAtMs: 1_700_000_000_000,
      approvedAtMs: 1_700_000_000_000,
    };
    const devicesDir = await writeLegacyFiles({
      paired: {
        "device-a": legacyPairedDevice("device-a", { nodeSurface }),
        "device-b": legacyPairedDevice("device-b"),
      },
      pending: { "req-1": { requestId: "req-1", deviceId: "device-c", ts: Date.now() } },
      bootstrap: { token: { token: "tok", ts: Date.now(), issuedAtMs: Date.now() } },
    });

    await expectMigration(2, 0);

    const imported = await getPairedDevice("device-a", baseDir);
    expect(imported).toMatchObject({
      deviceId: "device-a",
      publicKey: "pk-device-a",
      approvedVia: "owner",
      nodeSurface,
      tokens: { node: { token: "legacy-device-a" } },
    });

    // Transient pending/bootstrap rows are dropped, not imported.
    expect((await listDevicePairing(baseDir)).pending).toEqual([]);

    expect(await listDeviceFiles(devicesDir)).toEqual([
      "bootstrap.json.migrated",
      "paired.json.migrated",
      "pending.json.migrated",
    ]);

    expect(await migrateLegacyDevicePairingStore({ baseDir })).toBeNull();
  });

  test("keeps existing SQLite records over legacy rows for the same device id", async () => {
    const pending = await requestDevicePairing(
      { deviceId: "device-a", publicKey: "pk-current", role: "node", roles: ["node"], scopes: [] },
      baseDir,
    );
    const approved = await approveDevicePairing(
      pending.request.requestId,
      { callerScopes: [] },
      baseDir,
    );
    expect(approved?.status).toBe("approved");

    await writeLegacyFiles({
      paired: { "device-a": legacyPairedDevice("device-a") },
    });

    await expectMigration(0, 1);
    expect((await getPairedDevice("device-a", baseDir))?.publicKey).toBe("pk-current");
  });

  test("imports usable paired rows while omitting invalid optional fields", async () => {
    const devicesDir = await writeLegacyFiles({
      paired: {
        "device-a": legacyPairedDevice("device-a"),
        "request-a": {
          requestId: "request-a",
          deviceId: "device-a",
          publicKey: "pk-device-a",
          ts: 1_700_000_000_000,
        },
        "invalid-timestamp": legacyPairedDevice("invalid-timestamp", {
          createdAtMs: 1e100,
        }),
        "invalid-last-seen": legacyPairedDevice("invalid-last-seen", {
          lastSeenAtMs: 1e100,
        }),
        "invalid-text": {
          ...legacyPairedDevice("invalid-text"),
          displayName: { value: "Device" },
        },
      },
    });
    const warnings: string[] = [];

    const result = await migrateLegacyDevicePairingStore({
      baseDir,
      log: { info: () => {}, warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ imported: 3, skippedExisting: 0 });
    expect((await getPairedDevice("device-a", baseDir))?.publicKey).toBe("pk-device-a");
    const normalizedLastSeen = await getPairedDevice("invalid-last-seen", baseDir);
    expect(normalizedLastSeen?.publicKey).toBe("pk-invalid-last-seen");
    expect(normalizedLastSeen?.lastSeenAtMs).toBeUndefined();
    const normalizedText = await getPairedDevice("invalid-text", baseDir);
    expect(normalizedText?.publicKey).toBe("pk-invalid-text");
    expect(normalizedText?.displayName).toBeUndefined();
    expect(warnings).toEqual([
      "device pairing store migration skipped 2 invalid paired record(s)",
      "device pairing store migration omitted 2 invalid optional field(s)",
    ]);
    expect(await listDeviceFiles(devicesDir)).toEqual(["paired.json.migrated"]);
  });

  test("throws on an unreadable paired store and leaves the files in place", async () => {
    const devicesDir = path.join(baseDir, "devices");
    await fs.mkdir(devicesDir, { recursive: true });
    await fs.writeFile(path.join(devicesDir, "paired.json"), "{not-json}");

    await expect(migrateLegacyDevicePairingStore({ baseDir })).rejects.toThrow();
    expect(await listDeviceFiles(devicesDir)).toEqual(["paired.json"]);
  });

  test("archives transient-only legacy files without importing anything", async () => {
    const devicesDir = await writeLegacyFiles({
      pending: {},
      bootstrap: {},
    });

    await expectMigration(0, 0);
    expect(await listDeviceFiles(devicesDir)).toEqual([
      "bootstrap.json.migrated",
      "pending.json.migrated",
    ]);
  });

  test("device import before node fold lets legacy node surfaces land on imported records", async () => {
    await writeLegacyFiles({
      paired: { "device-a": legacyPairedDevice("device-a") },
    });
    await writeLegacyFiles(
      {
        paired: {
          "device-a": {
            nodeId: "device-a",
            displayName: "Kitchen Display",
            caps: ["screen"],
            createdAtMs: 1_700_000_000_000,
            approvedAtMs: 1_700_000_000_000,
          },
        },
      },
      "nodes",
    );

    await migrateLegacyDevicePairingStore({ baseDir });
    const folded = await migrateLegacyNodePairingStore({ baseDir });
    expect(folded).toEqual({ migrated: 1, orphaned: 0 });
    expect((await getPairedDevice("device-a", baseDir))?.nodeSurface).toMatchObject({
      displayName: "Kitchen Display",
      caps: ["screen"],
    });
  });
});
