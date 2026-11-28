import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sqliteFamilyHashes as familyHashes } from "../../test/helpers/sqlite-family-hashes.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureConfigHealthStateStore } from "../config/io.health-state.js";
import {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "../config/io.plugin-metadata.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { migrateLegacyConfigMachineState } from "../infra/state-migrations.config-machine-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import * as machineState from "../state/config-machine-state.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as bundledDiscovery from "./bundled-discovery-state.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { readStartupBundledDiscoveryMode } from "./gateway-startup-plugin-config.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { preparePluginMetadataMachineStateAsync } from "./installed-plugin-index-record-state.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  parseInstalledPluginIndex,
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { loadFreshManagedPluginMetadata } from "./management-service.js";
import {
  adoptProcessPluginCache,
  createPluginCache,
  getProcessPluginCache,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import { createPluginSourceAdmissionPublisher } from "./plugin-source-admission-store.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    bundledDiscovery.clearBundledDiscoveryModeMemo();
    cleanup();
  }),
);

function environment() {
  const root = dirs.make("openclaw-plugin-metadata-worker-");
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(bundled);
  return {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
  };
}

function index(message = "synthetic index"): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 123,
    installRecords: {},
    plugins: [],
    diagnostics: [{ level: "warn", message }],
  };
}

async function seed(env: NodeJS.ProcessEnv, value: InstalledPluginIndex) {
  const database = openOpenClawStateDatabase({ env });
  database.db
    .prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run("plugins.installedIndex", JSON.stringify({ revision: 1, index: value }), 123);
  await closeOpenClawStateDatabaseAsync();
  return database.path;
}

async function withoutMainThreadSql(run: () => Promise<void>) {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

it("transfers startup metadata out of its private snapshot and observes same-process migration", async () => {
  const env = environment();
  const config = { plugins: { allow: ["fixture"] } };
  await seed(env, index());
  const processCache = getProcessPluginCache();
  await using cache = createPluginCache();
  try {
    await withPluginCache(cache, () =>
      withArtifactPreservingStateReads(() =>
        withOpenClawStateDatabaseReadSnapshot(
          () => preparePluginMetadataMachineStateAsync({ env }),
          { env },
        ),
      ),
    );
    adoptProcessPluginCache(cache);
    await withoutMainThreadSql(async () => {
      await preparePluginMetadataMachineStateAsync({ env });
      expect(readStartupBundledDiscoveryMode(config, env)).toBeUndefined();
      expect((await readPersistedInstalledPluginIndex({ env }))?.diagnostics).toEqual(
        index().diagnostics,
      );
    });

    expect(migrateLegacyConfigMachineState({ config, env }).changes).toContain(
      "Migrated plugins.bundledDiscovery → shared SQLite state",
    );
    for (const snapshot of [false, true]) {
      const read = async () => {
        await bundledDiscovery.prepareBundledDiscoveryMode(env);
        await withoutMainThreadSql(async () => {
          expect(readStartupBundledDiscoveryMode(config, env)).toBe("compat");
          expect(readStartupBundledDiscoveryMode({}, env)).toBe("compat");
        });
      };
      if (snapshot) {
        await withArtifactPreservingStateReads(read);
      } else {
        await read();
      }
    }
  } finally {
    adoptProcessPluginCache(processCache);
  }
});

it("refreshes current package facts in pinned install roots without parent SQL or lost admissions", async () => {
  const env = environment();
  const roots = resolvePluginInstallRoots(env);
  const redirectedEnv = environment();
  const rootDir = path.join(roots.extensionsDir, "fixture");
  fs.mkdirSync(rootDir, { recursive: true });
  const fixture = createColdPluginFixture({ rootDir, pluginId: "refresh-fixture" });
  const config = {
    plugins: {
      entries: { [fixture.pluginId]: { enabled: true } },
    },
  };
  await seed(env, index());
  const refresh = () =>
    withPluginLifecycleLease({ env }, async (lease) => {
      await withoutMainThreadSql(async () => {
        await withPluginInstallRoots(roots, () =>
          refreshPluginRegistry({ config, env: redirectedEnv, lease, reason: "source-changed" }),
        );
      });
    });
  await refresh();
  const admission = {
    signature: "fixture-generation",
    sourceDigest: "a".repeat(64),
    nativeArtifacts: {},
    nativeNamespaces: {},
  };
  expect(
    await createPluginSourceAdmissionPublisher({ env })!({
      pluginId: fixture.pluginId,
      rootDir,
      key: rootDir,
      receipt: admission,
    }),
  ).toBe(true);
  createColdPluginFixture({ rootDir, pluginId: fixture.pluginId, packageVersion: "2.0.0" });
  await refresh();
  await withoutMainThreadSql(async () => {
    await withPluginCache(createPluginCache(), async () => {
      const persisted = await readPersistedInstalledPluginIndex({ env });
      expect(persisted?.plugins).toContainEqual(
        expect.objectContaining({
          pluginId: fixture.pluginId,
          packageVersion: "2.0.0",
          enabled: true,
          sourceAdmissions: { [rootDir]: admission },
        }),
      );
    });
  });
  expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
});

it("merges source admissions into the current install without main-thread SQL or stale-owner writes", async () => {
  const env = environment();
  const plugin = {
    pluginId: "native-demo",
    rootDir: "/plugins/native-demo",
    installRecordHash: "current-install",
    manifestPath: "/plugins/native-demo/openclaw.plugin.json",
    manifestHash: "manifest",
    origin: "global",
    enabled: true,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    compat: [],
  } satisfies InstalledPluginIndex["plugins"][number];
  const current = { ...index("current inventory"), plugins: [plugin] };
  await seed(env, current);
  const publication = {
    pluginId: plugin.pluginId,
    rootDir: plugin.rootDir,
    installRecordHash: plugin.installRecordHash,
    key: plugin.rootDir + "\0",
    receipt: {
      signature: "source-identity",
      sourceDigest: "a".repeat(64),
      nativeArtifacts: {
        "native-tool": {
          sourceIdentity: "1:2:3:4:5:6",
          contentHash: "b".repeat(64),
          sizeBytes: 4,
          capturedPath: "/captures/namespace/content/native-tool",
          namespace: "/captures/namespace",
          capturedIdentity: "1:7:3:4:5:6",
        },
      },
      nativeNamespaces: {
        "/captures/namespace": {
          sourceDirectory: plugin.rootDir,
          capturedRoot: "/captures/namespace",
          managed: false,
          members: {
            "native-tool": {
              source: plugin.rootDir + "/native-tool",
              sourceIdentity: "1:2:3:4:5:6",
              capturedIdentity: "1:7:3:4:5:6",
              boundaryChecked: false,
              contentHash: "b".repeat(64),
              sizeBytes: 4,
            },
          },
        },
      },
    },
  };
  await withoutMainThreadSql(async () => {
    const before = await metadataWorker.readPluginMetadataStateRow("installed-index", { env });
    const publish = createPluginSourceAdmissionPublisher({ env })!;
    expect(await withArtifactPreservingStateReads(() => publish(publication))).toBe(false);
    expect(await metadataWorker.readPluginMetadataStateRow("installed-index", { env })).toEqual(
      before,
    );
    expect(await publish(publication)).toBe(true);
    const committed = await metadataWorker.readPluginMetadataStateRow("installed-index", { env });
    await withPluginCache(createPluginCache(), async () => {
      const loaded = await readPersistedInstalledPluginIndex({ env });
      expect(loaded?.diagnostics).toEqual(current.diagnostics);
      expect(loaded?.plugins[0]?.sourceAdmissions).toEqual({
        [publication.key]: publication.receipt,
      });
    });
    expect(await publish(publication)).toBe(true);
    expect(await publish({ ...publication, rootDir: "/replaced/plugin" })).toBe(false);
    expect(await publish({ ...publication, installRecordHash: "old-install" })).toBe(false);
    expect(await metadataWorker.readPluginMetadataStateRow("installed-index", { env })).toEqual(
      committed,
    );
  });
  expect(
    parseInstalledPluginIndex({
      ...current,
      plugins: [{ ...plugin, sourceAdmissions: { invalid: { signature: 42 } } }],
    })?.plugins[0],
  ).toEqual(plugin);
});

it("preserves database-family bytes during ambient artifact-preserving async inspection", async () => {
  const env = environment();
  const databasePath = await seed(env, index());
  const before = familyHashes(databasePath);
  const inspect = () =>
    withPluginCache(createPluginCache(), async () => {
      expect(
        (
          await readPersistedInstalledPluginIndex({
            env,
          })
        )?.diagnostics,
      ).toEqual([{ level: "warn", message: "synthetic index" }]);
    });
  await withoutMainThreadSql(() => withArtifactPreservingStateReads(inspect));
  await closeOpenClawStateDatabaseAsync();
  expect(familyHashes(databasePath)).toEqual(before);
});

it("reads committed live startup metadata without space for a database snapshot", async () => {
  const env = environment();
  const databasePath = await seed(env, index());
  const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
  const writer = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerThreadExecArgv(
        new URL("../infra/gateway-state-owner.ts", import.meta.url),
      ),
      "--input-type=module",
      "--eval",
      `
        import { DatabaseSync } from "node:sqlite";
        import { acquireGatewayStateOwner } from ${JSON.stringify(moduleUrl("../infra/gateway-state-owner.ts"))};
        import { defaultPayload } from ${JSON.stringify(moduleUrl("../infra/gateway-state-owner-record.ts"))};
        const pathname = process.argv[1];
        const owner = acquireGatewayStateOwner({
          databasePath: pathname,
          payload: { ...defaultPayload(pathname), role: "gateway" },
        });
        const database = new DatabaseSync(pathname);
        database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE unrelated_payload(data BLOB)");
        database.prepare("INSERT INTO config_health_entries(config_path, last_observed_suspicious_signature, updated_at_ms) VALUES (?, ?, ?)").run("/synthetic/openclaw.json", "preserved-health", 123);
        process.on("message", value => {
          if (value === "close") {
            process.disconnect();
            return;
          }
          database.exec("BEGIN IMMEDIATE; INSERT INTO unrelated_payload VALUES(zeroblob(1048576))");
          if (value === "newer-schema") {
            database.exec("PRAGMA user_version=2147483647");
          } else {
            database.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key='plugins.installedIndex'").run(JSON.stringify(value));
          }
          database.exec("COMMIT");
          process.send("committed");
        });
        process.on("disconnect", () => { database.close(); owner.release(); });
        process.send("ready");
      `,
      databasePath,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  writer.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = once(writer, "close");
  const nextMessage = () =>
    Promise.race([
      once(writer, "message"),
      closed.then(([code]) => {
        throw new Error(`Synthetic metadata writer exited (${code}): ${stderr}`);
      }),
    ]);
  try {
    expect((await nextMessage())[0]).toBe("ready");
    const preload = path.join(env.OPENCLAW_STATE_DIR, "no-snapshot-space.cjs");
    fs.writeFileSync(
      preload,
      `
        const fs = require("node:fs");
        const original = fs.mkdtempSync;
        fs.mkdtempSync = function (prefix, ...args) {
          if (String(prefix).includes("openclaw-sqlite-readonly")) {
            throw Object.assign(new Error("synthetic snapshot disk full"), { code: "ENOSPC" });
          }
          return original.call(this, prefix, ...args);
        };
        require("node:module").syncBuiltinESMExports();
      `,
    );
    await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
      await withoutMainThreadSql(async () => {
        const health = await withArtifactPreservingStateReads(() =>
          captureConfigHealthStateStore(
            { env, homedir: () => env.OPENCLAW_STATE_DIR, logger: console },
            "/synthetic/openclaw.json",
          ).read(),
        );
        expect(health.state.entries?.["/synthetic/openclaw.json"]).toMatchObject({
          lastObservedSuspiciousSignature: "preserved-health",
        });
        expect(health.basis?.["/synthetic/openclaw.json"]?.updatedAtMs).toBe(123);
      });
      for (const message of ["first committed inventory", "inventory after unrelated growth"]) {
        const committed = nextMessage();
        writer.send({ revision: 1, index: index(message) });
        expect((await committed)[0]).toBe("committed");
        await withoutMainThreadSql(() =>
          withArtifactPreservingStateReads(() =>
            withPluginCache(createPluginCache(), async () => {
              expect((await readPersistedInstalledPluginIndex({ env }))?.diagnostics).toEqual([
                { level: "warn", message },
              ]);
            }),
          ),
        );
      }
    });
    const committed = nextMessage();
    writer.send("newer-schema");
    expect((await committed)[0]).toBe("committed");
    await expect(
      withArtifactPreservingStateReads(() =>
        withPluginCache(createPluginCache(), () => readPersistedInstalledPluginIndex({ env })),
      ),
    ).rejects.toBeInstanceOf(SqliteSchemaVersionError);
  } finally {
    if (writer.connected) {
      // Child-owned disconnect preserves Node's process-and-pipes close event.
      writer.send("close");
    }
    const [code] = await closed;
    expect(code, stderr).toBe(0);
  }
});

it("prepares cold metadata once and preserves the merged workspace inventory without main SQL", async () => {
  const env = environment();
  await seed(env, index());
  const otherEnv = environment();
  await seed(otherEnv, index());
  const workspaces = ["primary", "secondary"].map((id) => {
    const workspace = path.join(env.OPENCLAW_STATE_DIR, id);
    const root = path.join(workspace, ".openclaw", "extensions", id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "index.ts"),
      "throw new Error('metadata must not load runtime');\n",
    );
    fs.writeFileSync(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        configSchema: { type: "object", additionalProperties: false },
        channels: [`${id}-chat`],
      }),
    );
    return workspace;
  });
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: {
        ops: { workspace: workspaces[0] },
        research: { workspace: workspaces[1] },
      },
    },
    plugins: { allow: ["primary", "secondary"] },
  };
  const boot = resolveConfigWidePluginMetadataSnapshot({ config, env, allowCurrent: false });
  setGatewayPluginMetadataSnapshot(boot, { config, env });
  bundledDiscovery.clearBundledDiscoveryModeMemo();
  const prepareMode = bundledDiscovery.prepareBundledDiscoveryMode;
  const mode = vi
    .spyOn(bundledDiscovery, "prepareBundledDiscoveryMode")
    .mockImplementationOnce(async (capturedEnv, readPreparedRow) => {
      const activate = await prepareMode(capturedEnv, readPreparedRow);
      await prepareMode(otherEnv);
      await prepareMode(capturedEnv);
      return activate;
    });
  try {
    await withoutMainThreadSql(() =>
      withPluginCache(createPluginCache(), async () => {
        const first = await loadFreshManagedPluginMetadata(config, env);
        const second = await loadFreshManagedPluginMetadata(config, env);
        expect(first.plugins.map((plugin) => plugin.id)).toEqual(["primary", "secondary"]);
        expect(first.registryIndex.plugins.map((plugin) => plugin.pluginId)).toEqual(["primary"]);
        expect(first.registrySource).toBe("derived");
        expect(second).toBe(first);
      }),
    );
  } finally {
    mode.mockRestore();
    clearCurrentPluginMetadataSnapshot();
  }
});

it("joins a retired cache's worker read without publishing its inventory", async () => {
  const env = environment();
  const row = createDeferredCore<{ value_json: string }>();
  vi.spyOn(metadataWorker, "readPluginMetadataStateRow").mockReturnValue(row.promise);
  const cache = createPluginCache();
  const pending = withPluginCache(cache, () => readPersistedInstalledPluginIndex({ env }));
  const rejected = expect(pending).rejects.toThrow();
  const retirement = retirePluginCache(cache);
  row.resolve({ value_json: JSON.stringify({ revision: 1, index: index() }) });
  await rejected;
  await retirement;
});

it("keeps captured async policy and inventory in pinned roots after a concurrent memo refresh", async () => {
  const env = environment();
  await seed(env, index("captured ledger"));
  writeConfigMachineState("plugins.bundledDiscovery", "compat", { env });
  await closeOpenClawStateDatabaseAsync();
  const policyReads = vi.spyOn(machineState, "readConfigMachineState");
  const readEnv = environment();
  const captured = createDeferredCore();
  const resume = createDeferredCore();
  const afterCleanup = createDeferredCore();
  let descendant:
    | Promise<ReturnType<typeof bundledDiscovery.readBundledDiscoveryModeMemoized>>
    | undefined;
  const inspect = () =>
    withArtifactPreservingStateReads(() =>
      withPluginCache(createPluginCache(), () =>
        withOpenClawStateDatabaseReadSnapshot(
          async () => {
            captured.resolve();
            await resume.promise;
            const previousReads = policyReads.mock.calls.length;
            await withoutMainThreadSql(async () => {
              await resolveConfigWidePluginMetadataSnapshotAsync({
                config: {},
                env: readEnv,
                allowCurrent: false,
              });
            });
            const stored = readPersistedInstalledPluginIndexSync({ env: readEnv });
            const mode = bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv);
            for (let decision = 0; decision < 3; decision++) {
              expect(bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv)).toBe(mode);
            }
            expect(
              policyReads.mock.calls
                .slice(previousReads)
                .filter(([key]) => key === "plugins.bundledDiscovery"),
            ).toHaveLength(0);
            descendant = afterCleanup.promise.then(() =>
              bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv),
            );
            return { mode, diagnostics: stored?.diagnostics };
          },
          resolveInstalledPluginIndexStateDatabaseOptions({ env: readEnv }),
        ),
      ),
    );
  const reading = withPluginInstallRoots(resolvePluginInstallRoots(env), inspect);
  try {
    await Promise.race([captured.promise, reading]);
    // This writer runs outside the suspended inspection's async context.
    writeConfigMachineState("plugins.bundledDiscovery", "allowlist", { env });
    writeConfigMachineState(
      "plugins.installedIndex",
      { revision: 2, index: index("new ledger") },
      { env },
    );
    bundledDiscovery.clearBundledDiscoveryModeMemo();
    expect(bundledDiscovery.readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    resume.resolve();
    expect(await reading).toEqual({
      mode: "compat",
      diagnostics: [{ level: "warn", message: "captured ledger" }],
    });
    expect(bundledDiscovery.readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
    // An escaped descendant cannot replace its closed snapshot with live policy.
    writeConfigMachineState("plugins.bundledDiscovery", "compat", { env });
    afterCleanup.resolve();
    await expect(descendant).rejects.toThrow(StateDatabaseReadAdmissionInvalidatedError);
  } finally {
    resume.resolve();
    afterCleanup.resolve();
    await reading.catch(() => {});
    await descendant?.catch(() => {});
  }
});
