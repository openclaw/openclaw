import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import * as machineState from "../state/config-machine-state.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as bundledDiscovery from "./bundled-discovery-state.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import {
  readPersistedInstalledPluginIndex,
  readPersistedInstalledPluginIndexSync,
} from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";
import { listPersistedBundledPluginRecoveryLocations } from "./location-bridges.js";
import {
  createPluginCache,
  invalidatePluginCacheMetadata,
  PluginCacheFactInvalidatedError,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import * as metadataWorker from "./plugin-metadata-state-worker.js";

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

function familyHashes(databasePath: string) {
  return ["", "-wal", "-shm", "-journal"].map((suffix) => {
    const file = `${databasePath}${suffix}`;
    return fs.existsSync(file)
      ? [suffix, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]
      : [suffix, null];
  });
}

function observeParentSqlite() {
  const native = requireNodeSqlite();
  return [
    vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    vi.spyOn(native.DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(native.StatementSync.prototype, method),
    ),
  ];
}

it("returns a persisted index row without main-thread SQL", async () => {
  const env = environment();
  const message = "persisted fixture diagnostic";
  await seed(env, index(message));
  const counters = observeParentSqlite();
  try {
    await withPluginCache(createPluginCache(), async () => {
      const loaded = await readPersistedInstalledPluginIndex({ env });
      expect(loaded?.diagnostics).toEqual([{ level: "warn", message }]);
    });
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    for (const counter of counters) {
      counter.mockRestore();
    }
  }
});

it.each(["explicit", "ambient"] as const)(
  "preserves database-family bytes during %s artifact-preserving async inspection",
  async (scope) => {
    const env = environment();
    const databasePath = await seed(env, index());
    const before = familyHashes(databasePath);
    const inspect = () =>
      withPluginCache(createPluginCache(), async () => {
        expect(
          (
            await readPersistedInstalledPluginIndex({
              env,
              artifactPreservingReadOnly: scope === "explicit",
            })
          )?.diagnostics,
        ).toEqual([{ level: "warn", message: "synthetic index" }]);
      });
    if (scope === "ambient") {
      await withArtifactPreservingStateReads(inspect);
    } else {
      await inspect();
    }
    await closeOpenClawStateDatabaseAsync();
    expect(familyHashes(databasePath)).toEqual(before);
  },
);

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
  bundledDiscovery.clearBundledDiscoveryModeMemo();
  const prepareMode = bundledDiscovery.prepareBundledDiscoveryMode;
  const mode = vi
    .spyOn(bundledDiscovery, "prepareBundledDiscoveryMode")
    .mockImplementationOnce(async (capturedEnv) => {
      const activate = await prepareMode(capturedEnv);
      await prepareMode(otherEnv);
      await prepareMode(capturedEnv);
      return activate;
    });
  const reads = vi.spyOn(metadataWorker, "readPluginMetadataStateRow");
  const counters = observeParentSqlite();
  try {
    await withPluginCache(createPluginCache(), async () => {
      const first = await resolveConfigWidePluginMetadataSnapshotAsync({
        config,
        env,
        allowCurrent: false,
      });
      const second = await resolveConfigWidePluginMetadataSnapshotAsync({
        config,
        env,
        allowCurrent: false,
      });
      expect(first.plugins.map((plugin) => plugin.id)).toEqual(["primary", "secondary"]);
      expect(first.registryIndex.plugins.map((plugin) => plugin.pluginId)).toEqual(["primary"]);
      expect(first.registrySource).toBe("derived");
      expect(second).toBe(first);
      expect(reads.mock.calls.map(([selector]) => selector)).toEqual([
        "bundled-discovery",
        "bundled-discovery",
        "installed-index",
      ]);
    });
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    for (const counter of counters) {
      counter.mockRestore();
    }
    reads.mockRestore();
    mode.mockRestore();
  }
});

it("shares a pending index read and returns the same validated inventory", async () => {
  const env = environment();
  const row = createDeferredCore<{ value_json: string }>();
  const read = vi.spyOn(metadataWorker, "readPluginMetadataStateRow").mockReturnValue(row.promise);
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const first = readPersistedInstalledPluginIndex({ env });
    const second = readPersistedInstalledPluginIndex({ env });
    row.resolve({ value_json: JSON.stringify({ revision: 1, index: index() }) });
    const [left, right] = await Promise.all([first, second]);
    expect(left?.diagnostics).toEqual([{ level: "warn", message: "synthetic index" }]);
    expect(right).toBe(left);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

it("uses a newer synchronous index publication when an older worker read finishes", async () => {
  const env = environment();
  await seed(env, index("current ledger"));
  const row = createDeferredCore<{ value_json: string }>();
  vi.spyOn(metadataWorker, "readPluginMetadataStateRow").mockReturnValue(row.promise);
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const pending = readPersistedInstalledPluginIndex({ env });
    const current = readPersistedInstalledPluginIndexSync({ env });
    row.resolve({ value_json: JSON.stringify({ revision: 1, index: index("stale ledger") }) });
    expect(await pending).toBe(current);
    expect(current?.diagnostics).toEqual([{ level: "warn", message: "current ledger" }]);
  });
});

it("does not leak an invalidated worker mode into synchronous discovery", async () => {
  const env = environment();
  const row = createDeferredCore<{ value_json: string }>();
  vi.spyOn(metadataWorker, "readPluginMetadataStateRow").mockReturnValue(row.promise);
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const pending = bundledDiscovery.prepareBundledDiscoveryMode(env);
    const rejected = expect(pending).rejects.toThrow("Plugin state changed during preparation");
    invalidatePluginCacheMetadata(cache);
    row.resolve({ value_json: JSON.stringify("compat") });
    await rejected;
    expect(bundledDiscovery.readBundledDiscoveryModeMemoized(env)).toBeUndefined();
  });
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

it("returns persisted bundled recovery locations through its existing async consumer without parent SQL", async () => {
  const env = environment();
  const rootDir = path.join(env.OPENCLAW_STATE_DIR, "previous", "extensions", "fixture");
  const stored = index();
  stored.plugins = [
    ...stored.plugins,
    {
      pluginId: "fixture",
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      manifestHash: "synthetic-manifest",
      rootDir,
      origin: "bundled",
      enabled: true,
      startup: { sidecar: false, memory: false, agentHarnesses: [] },
      compat: [],
    },
  ];
  await seed(env, stored);
  const counters = observeParentSqlite();
  try {
    await using cache = createPluginCache();
    const recovered = await withPluginCache(cache, () =>
      listPersistedBundledPluginRecoveryLocations({ env }),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.pluginId).toBe("fixture");
    expect(recovered[0]?.loadPaths).toContain(rootDir);
    expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
  } finally {
    for (const counter of counters) {
      counter.mockRestore();
    }
  }
});

it("reads the installed ledger inside the existing install lifecycle lease without parent SQL", async () => {
  const env = environment();
  const stored = index();
  stored.installRecords = {
    fixture: { source: "path", installPath: path.join(env.OPENCLAW_STATE_DIR, "fixture") },
  };
  await seed(env, stored);
  await withPluginLifecycleLease({ env }, async (lease) => {
    lease.assertOwned();
    const counters = observeParentSqlite();
    try {
      const options = { env, filePath: lease.databasePath };
      expect(await loadInstalledPluginIndexInstallRecords(options)).toEqual(stored.installRecords);
      expect((await readPersistedInstalledPluginIndex(options))?.installRecords).toEqual(
        stored.installRecords,
      );
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      for (const counter of counters) {
        counter.mockRestore();
      }
    }
    lease.assertOwned();
  });
});

it.each([
  ...[false, true].flatMap((pinned) =>
    ["sync", "async", "async-empty-memo"].map((reader) => ({
      pinned,
      reader,
      initialMode: "compat" as const,
    })),
  ),
  { pinned: false, reader: "sync", initialMode: undefined },
])(
  "reads captured policy once and keeps it with inventory after a concurrent memo refresh ($reader, pinned roots: $pinned, mode: $initialMode)",
  async ({ pinned, reader, initialMode }) => {
    const env = environment();
    await seed(env, index("captured ledger"));
    if (initialMode) {
      writeConfigMachineState("plugins.bundledDiscovery", initialMode, { env });
    }
    await closeOpenClawStateDatabaseAsync();
    const policyReads = vi.spyOn(machineState, "readConfigMachineState");
    const readEnv = pinned ? environment() : env;
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
              if (reader !== "sync") {
                await resolveConfigWidePluginMetadataSnapshotAsync({
                  config: {},
                  env: readEnv,
                  allowCurrent: false,
                });
              }
              const stored = readPersistedInstalledPluginIndexSync({ env: readEnv });
              const mode = bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv);
              for (let decision = 0; decision < 3; decision++) {
                expect(bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv)).toBe(mode);
              }
              expect(
                policyReads.mock.calls
                  .slice(previousReads)
                  .filter(([key]) => key === "plugins.bundledDiscovery"),
              ).toHaveLength(1);
              descendant = afterCleanup.promise.then(() =>
                bundledDiscovery.readBundledDiscoveryModeMemoized(readEnv),
              );
              return { mode, diagnostics: stored?.diagnostics };
            },
            resolveInstalledPluginIndexStateDatabaseOptions({ env: readEnv }),
          ),
        ),
      );
    const reading = pinned
      ? withPluginInstallRoots(resolvePluginInstallRoots(env), inspect)
      : inspect();
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
      if (reader !== "async-empty-memo") {
        expect(bundledDiscovery.readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
      }
      resume.resolve();
      expect(await reading).toEqual({
        mode: initialMode,
        diagnostics: [{ level: "warn", message: "captured ledger" }],
      });
      expect(bundledDiscovery.readBundledDiscoveryModeMemoized(env)).toBe("allowlist");
      // An escaped descendant cannot replace its closed snapshot with live policy.
      writeConfigMachineState("plugins.bundledDiscovery", "compat", { env });
      afterCleanup.resolve();
      await expect(descendant).rejects.toThrow(PluginCacheFactInvalidatedError);
    } finally {
      resume.resolve();
      afterCleanup.resolve();
      await reading.catch(() => {});
      await descendant?.catch(() => {});
    }
  },
);

it("does not reactivate policy preparation inside a later snapshot of the same database", async () => {
  const env = environment();
  await seed(env, index());
  await withArtifactPreservingStateReads(() =>
    withPluginCache(createPluginCache(), async () => {
      const options = resolveInstalledPluginIndexStateDatabaseOptions({ env });
      const activate = await withOpenClawStateDatabaseReadSnapshot(
        () => bundledDiscovery.prepareBundledDiscoveryMode(env),
        options,
      );
      expect(activate).toThrow(PluginCacheFactInvalidatedError);
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        expect(activate).toThrow(PluginCacheFactInvalidatedError);
      }, options);
    }),
  );
});
