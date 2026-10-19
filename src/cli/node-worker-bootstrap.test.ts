import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  seedMacNodeWorkerProofState,
  readMacNodeWorkerProofRows,
} from "../../scripts/lib/mac-node-worker-proof-state.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeConfig,
  readConfigFileSnapshot,
  resetConfigRuntimeState,
} from "../config/config.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resetNodeHostPluginRegistry } from "../node-host/plugin-node-host.test-support.js";
import { prepareNodeHostRuntime } from "../node-host/runtime.js";
import { ensureNodeHostStateReady } from "../node-host/startup-state-readiness.js";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  initializeNativeOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import { ensureCliExecutionBootstrap } from "./command-execution-startup.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { testApi as configGuardTestApi } from "./program/config-guard.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pathEnv = captureEnv(["PATH", "OPENCLAW_PATH_BOOTSTRAPPED"]);
const enabledSchema = {
  type: "object",
  additionalProperties: false,
  properties: { enabled: { type: "boolean" } },
};
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const readFiles = (...files: string[]) => files.map((file) => fs.readFileSync(file));
afterAll(cleanupPluginLoaderFixturesForTest);
beforeEach(() => {
  resetConfigRuntimeState();
  configGuardTestApi.resetConfigGuardStateForTests();
});
afterEach(() => {
  pathEnv.restore();
  resetConfigRuntimeState();
  resetNodeHostPluginRegistry();
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  const root = fs.realpathSync(tempDirs.make("openclaw-worker-bootstrap-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  const nodePlugin = writePlugin({
    id: "fixture-node",
    configSchema: { ...enabledSchema, required: ["enabled"] },
    body: `module.exports = {
      id: "fixture-node",
      nodeHostCommands: [{ command: "fixture.inspect", cap: "fixture", handle: async () => "ok" }],
      register() {},
    };`,
  });
  const channelPlugin = writePlugin({
    id: "fixture-channel",
    body: "module.exports = { id: 'fixture-channel', register() {} };",
  });
  const manifestPath = path.join(channelPlugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  writeJson(manifestPath, {
    ...manifest,
    channels: ["fixture-channel"],
    channelConfigs: { "fixture-channel": { schema: enabledSchema } },
  });
  const nodeHost = {
    skills: { enabled: false },
    mcp: { servers: { fixture: { enabled: false, command: "fixture-mcp" } } },
  };
  const config = {
    channels: { "fixture-channel": { enabled: true, futureOption: true } },
    plugins: {
      allow: [nodePlugin.id, channelPlugin.id],
      load: { paths: [nodePlugin.file, channelPlugin.file] },
      entries: { [nodePlugin.id]: { enabled: true, config: { enabled: true } } },
    },
    nodeHost,
  };
  writeJson(configPath, config);
  return {
    root,
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    configPath,
    config,
  };
}

async function bootstrap(commandPath = ["node", "worker"]) {
  const error = vi.fn();
  await ensureCliExecutionBootstrap({
    commandPath,
    startupPolicy: resolveCliStartupPolicy({ commandPath, jsonOutputMode: false }),
    runtime: {
      log: vi.fn(),
      error,
      exit: (code) => {
        throw new Error(`exit ${code}: ${error.mock.calls.flat().join("\n")}`);
      },
    },
  });
}

describe("private node worker bootstrap", () => {
  it("preserves independently owned Gateway state during browser extension install bootstrap", async () => {
    const { databasePath, configPath, config } = fixture();
    seedMacNodeWorkerProofState(databasePath);
    const filesBefore = readFiles(databasePath, configPath);
    const artifactsBefore = fs.readdirSync(path.dirname(databasePath)).toSorted();

    await bootstrap(["browser", "extension", "install"]);

    expect(getRuntimeConfig().channels?.["fixture-channel"]).toEqual(
      config.channels["fixture-channel"],
    );
    expect(readFiles(databasePath, configPath)).toEqual(filesBefore);
    expect(fs.readdirSync(path.dirname(databasePath)).toSorted()).toEqual(artifactsBefore);
  });

  it.each([
    ["unknown", "CREATE TABLE unrelated (value TEXT)", false],
    [
      "metadata",
      "CREATE TABLE schema_meta (meta_key TEXT); INSERT INTO schema_meta VALUES ('occupied')",
      false,
    ],
    [
      "lease",
      "CREATE TABLE state_leases (owner TEXT); INSERT INTO state_leases VALUES ('occupied')",
      false,
    ],
    ["future", "PRAGMA user_version = 999", true],
    ["corrupt", "", true],
  ] as const)("does not adopt %s state as native bootstrap", async (shape, sql, throws) => {
    const { databasePath } = fixture();
    seedMacNodeWorkerProofState(databasePath);
    const db = new DatabaseSync(databasePath);
    if (sql) {
      db.exec(sql);
    }
    db.close();
    if (shape === "corrupt") {
      fs.writeFileSync(databasePath, "not a SQLite database");
    }
    const before = fs.readFileSync(databasePath);
    if (throws) {
      expect(initializeNativeOpenClawStateDatabase).toThrow();
    } else {
      expect(initializeNativeOpenClawStateDatabase()).toBeUndefined();
    }
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it("initializes native bootstrap before plugin state reads without losing native rows", async () => {
    const { databasePath } = fixture();
    const rows = seedMacNodeWorkerProofState(databasePath);
    await bootstrap();
    ensureNodeHostStateReady();
    const store = createPluginStateSyncKeyedStore("fixture-node", {
      namespace: "bootstrap-proof",
      maxEntries: 10,
    });
    expect(store.entries()).toEqual([]);
    closeOpenClawStateDatabaseForTest();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readMacNodeWorkerProofRows(database)).toEqual(rows);
    } finally {
      database.close();
    }
  });

  it("pins core config and preserves existing Gateway state", async () => {
    const { root, databasePath, configPath, config } = fixture();
    const includePath = path.join(root, "channels.json");
    writeJson(includePath, config.channels);
    writeJson(configPath, { ...config, channels: { $include: "channels.json" } });
    loadOrCreateDeviceIdentity();
    closeOpenClawStateDatabaseForTest();
    const filesBefore = readFiles(configPath, includePath, databasePath);

    // Prove the fixture really exceeds the older channel owner's schema.
    const full = await readConfigFileSnapshot({ observe: false });
    expect(full.valid).toBe(false);
    expect(full.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "channels.fixture-channel",
          message: expect.stringContaining("futureOption"),
        }),
      ]),
    );
    await bootstrap();
    const pinned = getRuntimeConfig();
    expect(pinned).toEqual(
      expect.objectContaining({
        nodeHost: config.nodeHost,
        channels: expect.objectContaining(config.channels),
      }),
    );
    // A cold worker must admit mature state even when snapshot storage is full.
    closeOpenClawStateDatabaseForTest();
    const allocateSnapshot = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw Object.assign(new Error("snapshot storage is full"), { code: "ENOSPC" });
    });
    try {
      initializeNativeOpenClawStateDatabase();
      expect(allocateSnapshot).not.toHaveBeenCalled();
    } finally {
      allocateSnapshot.mockRestore();
    }
    ensureNodeHostStateReady();
    const prepared = await prepareNodeHostRuntime();
    expect(getRuntimeConfig()).toBe(pinned);
    expect(prepared.manifest.commands).toEqual(
      expect.arrayContaining([
        "fixture.inspect",
        "mcp.tools.call.v1",
        "system.run",
        "system.run.prepare",
      ]),
    );
    await prepared
      .start({
        client: {
          request: async () => {
            throw new Error("unexpected Gateway request");
          },
        },
      })
      .close();
    // Drain workers and checkpoint WAL before comparing the complete persisted state.
    await closeOpenClawStateDatabaseAsync();
    expect(readFiles(configPath, includePath, databasePath)).toEqual(filesBefore);
  });

  it("rejects invalid node-owned browser settings", async () => {
    const { configPath, config } = fixture();
    writeJson(configPath, { ...config, nodeHost: { browserProxy: { enabled: "invalid" } } });
    await expect(bootstrap()).rejects.toThrow("nodeHost.browserProxy.enabled");
  });
});
