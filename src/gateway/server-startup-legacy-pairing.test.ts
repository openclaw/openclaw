import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getPairedDevice, listDevicePairing } from "../infra/device-pairing.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { readChannelPairingState } from "../pairing/pairing-store-sqlite.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { runGatewayStartupMaintenance } from "./server-startup-plugins.js";

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance: async () => {},
}));
vi.mock("./server-startup-session-migration.js", () => ({
  runStartupSessionMigration: async () => {},
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let sources: Map<string, string>;
const cfg = { plugins: { enabled: false } };

beforeEach(async () => {
  const home = temporary.make("openclaw-doctor-pairing-boundary-");
  stateDir = path.join(home, ".openclaw");
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  sources = new Map([
    [
      "devices/paired.json",
      JSON.stringify({
        synthetic: {
          deviceId: "synthetic",
          publicKey: "synthetic-public-key",
          role: "node",
          roles: ["node"],
          scopes: [],
          approvedScopes: [],
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      }),
    ],
    ["devices/pending.json", "{}"],
    ["devices/bootstrap.json", "{}"],
    ["nodes/paired.json", JSON.stringify({ synthetic: { caps: ["canvas"] } })],
    ["nodes/pending.json", "{}"],
  ]);
  for (const [relative, bytes] of sources) {
    const file = path.join(stateDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("legacy pairing repair ownership", () => {
  it("imports legacy DM requests and approvals only in Doctor mode", async () => {
    const timestamp = new Date().toISOString();
    const request = {
      id: "12345",
      code: "ABCDEFGH",
      createdAt: timestamp,
      lastSeenAt: timestamp,
      meta: { accountId: "default" },
    };
    const credentials = path.join(stateDir, "credentials");
    await fs.mkdir(credentials, { recursive: true });
    const legacy = new Map([
      [path.join(credentials, "telegram-pairing.json"), JSON.stringify({ requests: [request] })],
      [
        path.join(credentials, "telegram-default-allowFrom.json"),
        JSON.stringify({ allowFrom: ["67890"] }),
      ],
    ]);
    for (const [file, bytes] of legacy) {
      await fs.writeFile(file, bytes);
    }
    const before = readChannelPairingState("telegram", process.env);
    const params = { cfg, env: process.env, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };

    const automatic = await autoMigrateLegacyState(params);
    expect(automatic.stepReceipts.some((receipt) => receipt.id === "channel-pairing")).toBe(false);
    for (const [file, bytes] of legacy) {
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    }
    expect(readChannelPairingState("telegram", process.env)).toEqual(before);

    const repaired = await autoMigrateLegacyState({ ...params, doctorOnlyStateMigrations: true });
    expect(repaired.warnings).toEqual([]);
    expect(repaired.stepReceipts.find((receipt) => receipt.id === "channel-pairing")).toMatchObject(
      {
        outcome: "completed",
      },
    );
    expect(readChannelPairingState("telegram", process.env)).toMatchObject({
      requests: [request],
      allowFrom: { default: ["67890"] },
    });
    for (const file of legacy.keys()) {
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each(["EACCES", "EIO"])(
    "reports pairing inspection failure %s without treating it as absence",
    async (code) => {
      const access = fs.access;
      const failedPath = path.join(stateDir, "devices/paired.json");
      vi.spyOn(fs, "access").mockImplementation((file, mode) =>
        String(file) === failedPath
          ? Promise.reject(Object.assign(new Error(`synthetic ${code}`), { code }))
          : access(file, mode),
      );
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      await expect(
        runGatewayStartupMaintenance({
          cfgAtStart: cfg,
          startupRuntimeConfig: cfg,
          minimalTestGateway: false,
          log,
        }),
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`synthetic ${code}`));
      await expect(
        autoMigrateLegacyState({
          cfg,
          env: process.env,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        }),
      ).resolves.toBeDefined();
      const result = await autoMigrateLegacyState({
        cfg,
        env: process.env,
        doctorOnlyStateMigrations: true,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
      expect(
        result.stepReceipts.find((receipt) => receipt.id === "migration-detection"),
      ).toMatchObject({ outcome: "refused" });
      for (const [relative, bytes] of sources) {
        expect(await fs.readFile(path.join(stateDir, relative), "utf8")).toBe(bytes);
      }
    },
  );
  it("leaves legacy approvals intact during normal Gateway startup", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await runGatewayStartupMaintenance({
      cfgAtStart: cfg,
      startupRuntimeConfig: cfg,
      minimalTestGateway: false,
      log,
    });
    for (const [relative, bytes] of sources) {
      expect(await fs.readFile(path.join(stateDir, relative), "utf8")).toBe(bytes);
    }
    expect(await getPairedDevice("synthetic", stateDir)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
  });

  it("imports device approvals before node capabilities only in Doctor repair", async () => {
    const params = { cfg, env: process.env, legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };
    await autoMigrateLegacyState(params);
    for (const [relative, bytes] of sources) {
      expect(await fs.readFile(path.join(stateDir, relative), "utf8")).toBe(bytes);
    }
    const result = await autoMigrateLegacyState({ ...params, doctorOnlyStateMigrations: true });
    expect(result.warnings).toEqual([]);
    expect(await getPairedDevice("synthetic", stateDir)).toMatchObject({
      publicKey: "synthetic-public-key",
      roles: ["node"],
      nodeSurface: { caps: ["canvas"] },
    });
    expect((await listDevicePairing(stateDir)).pending).toEqual([]);
    for (const [relative, bytes] of sources) {
      expect(await fs.readFile(path.join(stateDir, relative) + ".migrated", "utf8")).toBe(bytes);
    }
    const repeated = await autoMigrateLegacyState({ ...params, doctorOnlyStateMigrations: true });
    expect(repeated.changes).toEqual([]);
  });

  it("leaves node capabilities available for retry when device import fails", async () => {
    const devicePath = path.join(stateDir, "devices/paired.json");
    const validDevices = sources.get("devices/paired.json")!;
    await fs.writeFile(devicePath, "{invalid");
    const params = {
      cfg,
      env: process.env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      doctorOnlyStateMigrations: true,
    };
    const failed = await autoMigrateLegacyState(params);
    expect(failed.stepReceipts.find((receipt) => receipt.id === "pairing-stores")).toMatchObject({
      outcome: "refused",
    });
    expect(await fs.readFile(devicePath, "utf8")).toBe("{invalid");
    expect(await fs.readFile(path.join(stateDir, "nodes/paired.json"), "utf8")).toBe(
      sources.get("nodes/paired.json"),
    );
    await fs.writeFile(devicePath, validDevices);
    await autoMigrateLegacyState(params);
    expect(await getPairedDevice("synthetic", stateDir)).toMatchObject({
      nodeSurface: { caps: ["canvas"] },
    });
  });
});
