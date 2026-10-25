import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { startSqliteCheckpointWriter } from "../infra/sqlite-checkpoint-writer.test-support.js";
import * as sqliteReadOnlyWorker from "../infra/sqlite-readonly-worker.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
} from "../plugins/bundled-discovery-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as configContext from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import * as configHealth from "./io.health-state.js";
import * as pluginMetadata from "./io.plugin-metadata.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { readCurrentConfigForPolicyCheckAsync } from "./io.runtime.js";
import { createConfigIoWorkerFixture } from "./io.worker.test-support.js";
import type { ConfigFileSnapshot } from "./types.js";

const shell = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  loadShellEnvFallback: shell.load,
}));

const workerRoots = createSuiteTempRootTracker({ prefix: "openclaw-config-load-workers-" });
const workers = createConfigIoWorkerFixture();
beforeAll(async () => {
  await workers.setup(await workerRoots.setup());
});
afterAll(async () => {
  await workers.close();
  await workerRoots.cleanup();
});

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    shell.load.mockReset();
    await closeOpenClawStateDatabaseAsync();
    clearBundledDiscoveryModeMemo();
    cleanup();
  }),
);

function fixture(config?: unknown) {
  const home = dirs.make("openclaw-config-async-");
  const bundled = path.join(home, "bundled");
  fs.mkdirSync(bundled);
  const configPath = path.join(home, "openclaw.json");
  if (config !== undefined) {
    fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    VITEST: "true",
  };
  const options = {
    env,
    configPath,
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  return {
    ...options,
    io: createConfigIO(options),
    health: () => configHealth.readConfigHealthStateFromStore(options).entries?.[configPath],
    patch: (patch: Parameters<typeof configHealth.patchConfigHealthEntryToStore>[2]) =>
      configHealth.patchConfigHealthEntryToStore(options, configPath, patch),
  };
}

function cached<T>(run: () => T) {
  return withPluginCache(createPluginCache(), run);
}

async function pendingFixture() {
  const source = { gateway: { mode: "local" }, session: { store: "/srv/synthetic-sessions.json" } };
  const raw = JSON.stringify(source);
  const options = fixture(raw);
  const pending = {
    pluginId: "fixture-plugin",
    reason: "Synthetic pending migration",
    command: "openclaw plugins install @example/fixture-plugin",
    configPaths: [["session", "store"]],
    validationExcludedPaths: [["session", "store"]],
  };
  await recordDeferredPluginMigrations({ env: options.env, pending: [pending] });
  await closeOpenClawStateDatabaseAsync();
  return {
    options,
    source,
    raw,
    pending,
    databasePath: resolveOpenClawStateSqlitePath(options.env),
  };
}

async function withoutMainSql<T>(run: () => Promise<T>) {
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
}

function barrier<T = void>() {
  const entered = createDeferredCore<T>();
  const release = createDeferredCore();
  return {
    release: () => release.resolve(),
    pause: async (value: T) => {
      entered.resolve(value);
      await release.promise;
    },
    wait: (pending: Promise<unknown>) =>
      Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("operation completed before its controlled boundary");
        }),
      ]),
    drain: async (pending: Promise<unknown>) => {
      release.resolve();
      await Promise.allSettled([pending]);
    },
  };
}

function pauseMetadata(pause: () => Promise<void>, once = false) {
  const original = pluginMetadata.resolveConfigWidePluginMetadataSnapshotAsync;
  const spy = vi.spyOn(pluginMetadata, "resolveConfigWidePluginMetadataSnapshotAsync");
  const run: typeof original = async (params) => {
    const result = await original(params);
    await pause();
    return result;
  };
  if (once) {
    spy.mockImplementationOnce(run);
  } else {
    spy.mockImplementation(run);
  }
}

function observeWith(
  before?: (snapshot: ConfigFileSnapshot) => Promise<void>,
  after?: () => Promise<void>,
) {
  const createContext = configContext.createConfigIoContext;
  vi.spyOn(configContext, "createConfigIoContext").mockImplementation((options) => {
    const context = createContext(options);
    const observe = context.observeLoadConfigSnapshotAsync;
    return {
      ...context,
      observeLoadConfigSnapshotAsync: async (snapshot, assertCurrent) => {
        await before?.(snapshot);
        const observed = await observe(snapshot, assertCurrent);
        await after?.();
        return observed;
      },
    };
  });
}

it.each(["load", "metadata", "policy"] as const)(
  "offline %s consumes canonical config without reading pending migrations or changing artifacts",
  async (method) => {
    const { options, source, raw, pending, databasePath } = await pendingFixture();
    const family = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const familyBefore = family.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
    const synchronousSnapshot = vi.spyOn(sqliteReadOnlyWorker, "runSqliteReadOnlyWorkerSync");
    await withoutMainSql(async () => {
      const read = () =>
        cached(async () => {
          if (method === "policy") {
            return await readCurrentConfigForPolicyCheckAsync(options);
          }
          const io = createConfigIO({ ...options, observe: false });
          if (method === "load") {
            return await io.loadConfigAsync();
          }
          const { snapshot } = await io.readConfigFileSnapshotWithPluginMetadata();
          expect(snapshot).toMatchObject({ valid: true, raw });
          return snapshot.config;
        });
      // Plain loads use their caller's inspection scope; snapshot APIs own theirs.
      const config = await (method === "load" || method === "policy"
        ? withArtifactPreservingStateReads(read)
        : read());
      expect(config).toMatchObject(source);
      expect(synchronousSnapshot).not.toHaveBeenCalled();
    });
    expect(fs.readFileSync(options.configPath, "utf8")).toBe(raw);
    expect(family.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null))).toEqual(
      familyBefore,
    );
    expect(readDeferredPluginMigrations({ env: options.env })).toEqual([pending]);
  },
);

it("validates config and update ownership snapshots while a verified live writer checkpoints", async () => {
  const { options, raw, databasePath } = await pendingFixture();
  const writer = await startSqliteCheckpointWriter(databasePath);
  const owner = acquireGatewayStateOwner({
    databasePath,
    payload: { ...defaultPayload(databasePath), role: "gateway" },
  });
  try {
    await withoutMainSql(async () => {
      for (const method of ["metadata", "write-snapshot"] as const) {
        await cached(async () => {
          const io = createConfigIO({ ...options, observe: false });
          const result =
            method === "metadata"
              ? await io.readConfigFileSnapshotWithPluginMetadata()
              : await io.readConfigFileSnapshotForWrite();
          expect(result.snapshot).toMatchObject({ valid: true, raw });
        });
      }
    });
    expect(fs.readFileSync(options.configPath, "utf8")).toBe(raw);
  } finally {
    await writer.stop();
    owner.release();
  }
});

it("rejects an invalid async load and rolls back its injected config environment", async () => {
  const { io, env } = fixture({
    gateway: { port: "invalid" },
    env: { vars: { CONFIG_FIXTURE_VALUE: "rejected" } },
  });
  await expect(io.loadConfigAsync()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(env.CONFIG_FIXTURE_VALUE).toBeUndefined();
});

it("uses the same fresh-install defaults for a missing async configuration", async () => {
  const { io } = fixture();
  const config = await cached(() => io.loadConfigAsync());
  const legacy = cached(() => io.loadConfig());
  expect(config).toEqual(legacy);
  expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
});

it.each(["full", "core-only"] as const)(
  "prepares shell key metadata for a %s async load without native SQL",
  async (pluginValidation) => {
    const { env, configPath, homedir, logger } = fixture({ env: { shellEnv: { enabled: true } } });
    await withoutMainSql(async () => {
      await cached(() =>
        createConfigIO({ env, configPath, homedir, logger, pluginValidation }).loadConfigAsync(),
      );
      expect(shell.load).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          env,
          expectedKeys: expect.arrayContaining([
            "OPENCLAW_GATEWAY_TOKEN",
            "OPENCLAW_GATEWAY_PASSWORD",
          ]),
        }),
      );
    });
  },
);

it.each(["metadata", "recovered", "invalid", "queued-write"] as const)(
  "preserves current state after superseding an async load at %s",
  async (phase) => {
    const gate = barrier<ConfigFileSnapshot | undefined>();
    const config = (port: number) => ({
      meta: { lastTouchedVersion: "2026.9.3" },
      gateway: { mode: "local", port },
    });
    const raw = JSON.stringify(
      phase === "recovered"
        ? { update: { channel: "beta" } }
        : phase === "invalid"
          ? { gateway: { port: "invalid" } }
          : phase === "queued-write"
            ? config(19101)
            : { gateway: { mode: "local" }, plugins: { enabled: false } },
    );
    if (phase === "metadata") {
      pauseMetadata(() => gate.pause(undefined), true);
    } else if (phase === "queued-write") {
      const capture = configHealth.captureConfigHealthStateStore;
      vi.spyOn(configHealth, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          update: async (...updates) => {
            await gate.pause(undefined);
            return store.update(...updates);
          },
        };
      });
    } else {
      observeWith((snapshot) => gate.pause(snapshot));
    }
    const { io, configPath, health, patch } = fixture(raw);
    if (phase === "recovered" || phase === "invalid") {
      fs.writeFileSync(
        `${configPath}.bak`,
        JSON.stringify({
          meta: { lastTouchedVersion: "2026.9.3" },
          gateway: {
            mode: "local",
            trustedProxies: Array.from({ length: 60 }, (_, i) => `192.0.2.${i}`),
          },
        }),
      );
    }
    let current = true;
    const load = () =>
      io.loadConfigAsync({
        assertCurrent: () => {
          if (!current) {
            throw new Error("fixture reader superseded");
          }
        },
      });
    const pending = phase === "metadata" ? cached(load) : load();
    try {
      const snapshot = await gate.wait(pending);
      if (phase === "recovered" || phase === "invalid") {
        expect(snapshot?.valid).toBe(phase === "recovered");
        patch({ lastObservedSuspiciousSignature: "newer-reader" });
      } else if (phase === "queued-write") {
        const newerRaw = JSON.stringify(config(19102));
        fs.writeFileSync(configPath, newerRaw);
        expect(io.loadConfig().gateway?.port).toBe(19102);
        expect(health()?.lastKnownGood?.hash).toBe(hashConfigRaw(newerRaw));
      }
      const newer = health();
      current = false;
      const rejected = expect(pending).rejects.toThrow("fixture reader superseded");
      gate.release();
      await rejected;
      if (phase === "metadata") {
        expect(health()).toBeUndefined();
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      } else {
        expect(health()).toEqual(newer);
      }
    } finally {
      await gate.drain(pending);
    }
  },
);

it("keeps prepared discovery facts when another root loads during health observation", async () => {
  const first = fixture({ gateway: { mode: "local", port: 19001 } });
  const other = fixture();
  observeWith(undefined, async () => {
    await prepareBundledDiscoveryMode(other.env);
  });
  const io = createConfigIO(first);
  const config = await withoutMainSql(() => cached(() => io.loadConfigAsync()));
  expect(config.gateway?.port).toBe(19001);
});

it("keeps core-only model defaults out of synchronous plugin discovery", async () => {
  const options = fixture({
    models: {
      providers: {
        "fixture-provider": {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          models: [{ id: "fixture-model", name: "Fixture model" }],
        },
      },
    },
  });
  configHealth.patchConfigHealthEntryToStore(options, options.configPath, {
    lastObservedSuspiciousSignature: "fixture-state",
  });
  for (const key of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_BUNDLED_PLUGINS_DIR"] as const) {
    vi.stubEnv(key, options.env[key]);
  }
  try {
    const config = await withoutMainSql(() =>
      cached(() => createConfigIO({ ...options, pluginValidation: "core-only" }).loadConfigAsync()),
    );
    expect(config.models?.providers?.["fixture-provider"]?.models[0]?.id).toBe("fixture-model");
  } finally {
    vi.unstubAllEnvs();
  }
});
