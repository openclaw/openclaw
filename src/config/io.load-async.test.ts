import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import {
  clearBundledDiscoveryModeMemo,
  prepareBundledDiscoveryMode,
} from "../plugins/bundled-discovery-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import * as configContext from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import * as configHealth from "./io.health-state.js";
import * as pluginMetadata from "./io.plugin-metadata.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot } from "./types.js";

const shell = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  loadShellEnvFallback: shell.load,
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    shell.load.mockReset();
    await closeOpenClawStateDatabaseAsync();
    clearBundledDiscoveryModeMemo();
    cleanup();
  }),
);

function fixture(raw?: string) {
  const home = dirs.make("openclaw-config-async-");
  const bundled = path.join(home, "bundled");
  fs.mkdirSync(bundled);
  const configPath = path.join(home, "openclaw.json");
  if (raw !== undefined) {
    fs.writeFileSync(configPath, raw);
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
  return { ...options, io: createConfigIO(options) };
}

it("strictly loads cold plugin metadata and records health without main-thread SQLite", async () => {
  const raw = JSON.stringify({
    gateway: { mode: "local", auth: { mode: "token", token: "${MISSING_FIXTURE_TOKEN}" } },
    env: { vars: { CONFIG_FIXTURE_VALUE: "accepted" } },
  });
  const { io, env, configPath, homedir, logger } = fixture(raw);
  const mainSql = observeMainThreadSql();
  try {
    const config = await withPluginCache(createPluginCache(), () => io.loadConfigAsync());
    expect(config.gateway?.mode).toBe("local");
    expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect([...(getConfigResolutionFacts(config) ?? [])]).toContain("gateway.auth.token");
    expect(env.CONFIG_FIXTURE_VALUE).toBe("accepted");
    mainSql.expectIdle();
  } finally {
    mainSql.restore();
  }
  expect(
    configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[configPath]
      ?.lastKnownGood?.hash,
  ).toBe(hashConfigRaw(raw));
  expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
});

it("loads retained migration inputs in an artifact-preserving async scope without parent SQL", async () => {
  const raw = JSON.stringify({
    gateway: { mode: "local" },
    session: { store: "/srv/synthetic-session-state/sessions.json" },
  });
  const options = fixture(raw);
  const pending = {
    pluginId: "fixture-plugin",
    reason: "The configured plugin is not installed.",
    command: "openclaw plugins install @example/fixture-plugin",
    configPaths: [["session", "store"]],
    validationExcludedPaths: [["session", "store"]],
  };
  recordDeferredPluginMigrations({ env: options.env, pending: [pending] });
  await closeOpenClawStateDatabaseAsync();
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  const family = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const familyBefore = family.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
  const mainSql = observeMainThreadSql();
  try {
    const config = await withArtifactPreservingStateReads(() =>
      withPluginCache(createPluginCache(), () =>
        createConfigIO({ ...options, observe: false }).loadConfigAsync(),
      ),
    );
    expect(config.gateway?.mode).toBe("local");
    expect(config).not.toHaveProperty("session.store");
    mainSql.expectIdle();
  } finally {
    mainSql.restore();
  }
  expect(fs.readFileSync(options.configPath, "utf8")).toBe(raw);
  expect(family.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null))).toEqual(
    familyBefore,
  );
  expect(readDeferredPluginMigrations({ env: options.env })).toEqual([pending]);
});

it("rejects an invalid async load and rolls back its injected config environment", async () => {
  const { io, env } = fixture(
    JSON.stringify({
      gateway: { port: "invalid" },
      env: { vars: { CONFIG_FIXTURE_VALUE: "rejected" } },
    }),
  );
  await expect(io.loadConfigAsync()).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(env.CONFIG_FIXTURE_VALUE).toBeUndefined();
});

it("uses the same fresh-install defaults for a missing async configuration", async () => {
  const { io } = fixture();
  const config = await withPluginCache(createPluginCache(), () => io.loadConfigAsync());
  const legacy = withPluginCache(createPluginCache(), () => io.loadConfig());
  expect(config).toEqual(legacy);
  expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
});

it.each(["full", "core-only"] as const)(
  "prepares shell key metadata for a %s async load without native SQL",
  async (pluginValidation) => {
    const { env, configPath, homedir, logger } = fixture(
      JSON.stringify({ env: { shellEnv: { enabled: true } } }),
    );
    const mainSql = observeMainThreadSql();
    try {
      await withPluginCache(createPluginCache(), () =>
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
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
  },
);

it("rechecks the cold reader before observation after delayed metadata preparation", async () => {
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  const { io, env, homedir, configPath, logger } = fixture(raw);
  const started = createDeferredCore();
  const release = createDeferredCore();
  const resolveMetadata = pluginMetadata.resolveConfigWidePluginMetadataSnapshotAsync;
  vi.spyOn(pluginMetadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockImplementationOnce(
    async (params) => {
      const snapshot = await resolveMetadata(params);
      started.resolve();
      await release.promise;
      return snapshot;
    },
  );
  let current = true;
  const pending = withPluginCache(createPluginCache(), () =>
    io.loadConfigAsync({
      assertCurrent: () => {
        if (!current) {
          throw new Error("fixture reader superseded");
        }
      },
    }),
  );
  try {
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("metadata gate was not reached");
      }),
    ]);
    current = false;
    const rejected = expect(pending).rejects.toThrow("fixture reader superseded");
    release.resolve();
    await rejected;
    expect(
      configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[configPath],
    ).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
});

it.each(["recovered", "invalid"] as const)(
  "preserves newer health state after superseding %s configuration observation",
  async (mode) => {
    const entered = createDeferredCore<ConfigFileSnapshot>();
    const release = createDeferredCore();
    const createContext = configContext.createConfigIoContext;
    vi.spyOn(configContext, "createConfigIoContext").mockImplementation((options) => {
      const context = createContext(options);
      const observe = context.observeLoadConfigSnapshotAsync;
      return {
        ...context,
        observeLoadConfigSnapshotAsync: async (snapshot, assertCurrent) => {
          entered.resolve(snapshot);
          await release.promise;
          return observe(snapshot, assertCurrent);
        },
      };
    });
    const raw = JSON.stringify(
      mode === "recovered" ? { update: { channel: "beta" } } : { gateway: { port: "invalid" } },
    );
    const { io, env, homedir, configPath, logger } = fixture(raw);
    fs.writeFileSync(
      `${configPath}.bak`,
      JSON.stringify({
        meta: { lastTouchedVersion: "2026.9.3" },
        gateway: {
          mode: "local",
          trustedProxies: Array.from({ length: 60 }, (_, index) => `192.0.2.${index}`),
        },
      }),
    );
    let current = true;
    const pending = io.loadConfigAsync({
      assertCurrent: () => {
        if (!current) {
          throw new Error("fixture reader superseded");
        }
      },
    });
    try {
      const snapshot = await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("observation was not reached");
        }),
      ]);
      expect(snapshot.valid).toBe(mode === "recovered");
      configHealth.patchConfigHealthEntryToStore({ env, homedir, logger }, configPath, {
        lastObservedSuspiciousSignature: "newer-reader",
      });
      const newer = configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[
        configPath
      ];
      current = false;
      const rejected = expect(pending).rejects.toThrow("fixture reader superseded");
      release.resolve();
      await rejected;
      expect(
        configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[configPath],
      ).toEqual(newer);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

it("does not replace a newer synchronous observation with a superseded queued health write", async () => {
  const started = createDeferredCore();
  const release = createDeferredCore();
  const capture = configHealth.captureConfigHealthStateStore;
  vi.spyOn(configHealth, "captureConfigHealthStateStore").mockImplementation((...captureArgs) => {
    const store = capture(...captureArgs);
    return {
      ...store,
      update: async (...updateArgs) => {
        started.resolve();
        await release.promise;
        return store.update(...updateArgs);
      },
    };
  });
  const config = (port: number) => ({
    meta: { lastTouchedVersion: "2026.9.3" },
    gateway: { mode: "local", port },
  });
  const { io, env, homedir, configPath, logger } = fixture(JSON.stringify(config(19101)));
  let current = true;
  const pending = io.loadConfigAsync({
    assertCurrent: () => {
      if (!current) {
        throw new Error("fixture reader superseded");
      }
    },
  });
  try {
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("health write was not reached");
      }),
    ]);
    const raw = JSON.stringify(config(19102));
    fs.writeFileSync(configPath, raw);
    expect(io.loadConfig().gateway?.port).toBe(19102);
    const newer = configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[
      configPath
    ];
    expect(newer?.lastKnownGood?.hash).toBe(hashConfigRaw(raw));
    current = false;
    const rejected = expect(pending).rejects.toThrow("fixture reader superseded");
    release.resolve();
    await rejected;
    expect(
      configHealth.readConfigHealthStateFromStore({ env, homedir, logger }).entries?.[configPath],
    ).toEqual(newer);
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
});

it("keeps prepared discovery facts when another root loads during health observation", async () => {
  const first = fixture(JSON.stringify({ gateway: { mode: "local", port: 19001 } }));
  const other = fixture();
  const createContext = configContext.createConfigIoContext;
  vi.spyOn(configContext, "createConfigIoContext").mockImplementation((options) => {
    const context = createContext(options);
    const observe = context.observeLoadConfigSnapshotAsync;
    return {
      ...context,
      observeLoadConfigSnapshotAsync: async (snapshot, assertCurrent) => {
        const observed = await observe(snapshot, assertCurrent);
        await prepareBundledDiscoveryMode(other.env);
        return observed;
      },
    };
  });
  const io = createConfigIO(first);
  const mainSql = observeMainThreadSql();
  const config = await withPluginCache(createPluginCache(), () => io.loadConfigAsync());
  expect(config.gateway?.port).toBe(19001);
  mainSql.expectIdle();
});

it("keeps core-only model defaults out of synchronous plugin discovery", async () => {
  const options = fixture(
    JSON.stringify({
      models: {
        providers: {
          "fixture-provider": {
            baseUrl: "https://example.invalid/v1",
            api: "openai-completions",
            models: [{ id: "fixture-model", name: "Fixture model" }],
          },
        },
      },
    }),
  );
  configHealth.patchConfigHealthEntryToStore(options, options.configPath, {
    lastObservedSuspiciousSignature: "fixture-state",
  });
  for (const key of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_BUNDLED_PLUGINS_DIR"] as const) {
    vi.stubEnv(key, options.env[key]);
  }
  try {
    const mainSql = observeMainThreadSql();
    const config = await withPluginCache(createPluginCache(), () =>
      createConfigIO({ ...options, pluginValidation: "core-only" }).loadConfigAsync(),
    );
    expect(config.models?.providers?.["fixture-provider"]?.models[0]?.id).toBe("fixture-model");
    mainSql.expectIdle();
  } finally {
    vi.unstubAllEnvs();
  }
});
