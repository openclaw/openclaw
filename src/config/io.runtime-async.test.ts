import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { prepareConfigRuntimeEnv } from "./config-env-vars.js";
import { readConfigHealthStateFromStore } from "./io.health-state.js";
import { createManagedRuntimeEnvBase } from "./io.runtime-env.js";
import {
  captureRuntimeConfigAsyncReader,
  registerConfigWriteListener,
  writeConfigFile,
} from "./io.runtime.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearBundledDiscoveryModeMemo();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

function fixture(config: unknown = { gateway: { mode: "local", port: 18789 } }) {
  const home = dirs.make("openclaw-runtime-config-async-");
  const state = path.join(home, "state");
  const workspace = path.join(home, "workspace");
  const bundled = path.join(home, "bundled");
  for (const directory of [state, workspace, bundled]) {
    fs.mkdirSync(directory);
  }
  const configPath = path.join(state, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  fs.writeFileSync(path.join(workspace, ".env"), "CONFIG_ASYNC_WORKSPACE=workspace\n");
  fs.writeFileSync(path.join(state, ".env"), "CONFIG_ASYNC_GLOBAL=global\n");
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_LOAD_SHELL_ENV: undefined,
    CONFIG_ASYNC_WORKSPACE: undefined,
    CONFIG_ASYNC_GLOBAL: undefined,
    CONFIG_ASYNC_CONFIG: undefined,
    CONFIG_ASYNC_ADDED: undefined,
    CONFIG_ASYNC_FALLBACK: undefined,
    CONFIG_WORKER_STAGED: undefined,
  })) {
    vi.stubEnv(key, value);
  }
  vi.spyOn(process, "cwd").mockReturnValue(workspace);
  return { home, state, workspace, configPath };
}

async function withoutMainSql<T>(run: () => Promise<T>): Promise<T> {
  const mainSql = observeMainThreadSql();
  try {
    return await run();
  } finally {
    try {
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
  }
}

it("preserves SDK config writes and load authority inside a native worker", async () => {
  const { configPath } = fixture();
  const worker = new Worker(
    new URL("./io.runtime-async.worker.test-support.mjs", import.meta.url),
    {
      execArgv: [],
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      workerData: { configPath, sourceLoaderUrl: import.meta.resolve("tsx/esm/api") },
    },
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      let message: unknown;
      worker.on("message", (value: unknown) => {
        message = value;
      });
      worker.on("error", reject);
      worker.on("exit", (code) => {
        if (code === 0) {
          resolve(message);
        } else {
          reject(new Error(`Config worker exited with code ${code}`));
        }
      });
    });
    expect(result).toEqual({
      isMainThread: false,
      wroteConfig: true,
      isolatedDotEnv: true,
      rejectedStaleLoad: true,
    });
  } finally {
    await worker.terminate();
  }
});

it.each(["config environment", "dotenv selector"] as const)(
  "pins the selected config while publishing staged %s without main SQL",
  async (mode) => {
    const { home, state, configPath } = fixture(
      mode === "config environment"
        ? {
            gateway: { mode: "local", auth: { mode: "token", token: "${CONFIG_ASYNC_GLOBAL}" } },
            env: { vars: { CONFIG_ASYNC_CONFIG: "config" } },
          }
        : undefined,
    );
    const other = path.join(state, "other.json");
    if (mode === "dotenv selector") {
      fs.writeFileSync(other, JSON.stringify({ gateway: { mode: "local", port: 19001 } }));
      fs.writeFileSync(path.join(state, ".env"), `OPENCLAW_CONFIG_PATH=${other}\n`);
    }
    await withPluginCache(createPluginCache(), async () => {
      const read = captureRuntimeConfigAsyncReader();
      expect(process.env.CONFIG_ASYNC_WORKSPACE).toBeUndefined();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const config = await withoutMainSql(read);
      expect(getRuntimeConfigSnapshot()).toBe(config);
      expect(await read()).toBe(config);
      if (mode === "dotenv selector") {
        expect(config.gateway?.port).toBe(18789);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBe(other);
      } else {
        expect(config.gateway?.auth?.token).toBe("global");
        expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
        expect(process.env.CONFIG_ASYNC_WORKSPACE).toBe("workspace");
        expect(process.env.CONFIG_ASYNC_GLOBAL).toBe("global");
        expect(process.env.CONFIG_ASYNC_CONFIG).toBe("config");
      }
    });
    if (mode === "config environment") {
      expect(
        readConfigHealthStateFromStore({
          env: { HOME: home, OPENCLAW_STATE_DIR: state },
          homedir: () => home,
          logger: console,
        }).entries?.[configPath]?.lastKnownGood,
      ).toBeDefined();
    }
  },
);

it.each(["validation", "namespace"] as const)(
  "rejects a cold load after %s failure without publishing config environment",
  async (failure) => {
    fixture(
      failure === "validation"
        ? {
            gateway: { port: "invalid" },
            env: { vars: { CONFIG_ASYNC_CONFIG: "rejected" } },
          }
        : undefined,
    );
    const read = captureRuntimeConfigAsyncReader();
    if (failure === "namespace") {
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "/fixture/another-config.json");
    }
    const pending = withoutMainSql(() => withPluginCache(createPluginCache(), read));
    if (failure === "validation") {
      await expect(pending).rejects.toMatchObject({ code: "INVALID_CONFIG" });
      expect(process.env.CONFIG_ASYNC_GLOBAL).toBe("global");
    } else {
      await expect(pending).rejects.toThrow("Runtime config source changed");
    }
    expect(process.env.CONFIG_ASYNC_WORKSPACE).toBe(
      failure === "validation" ? "workspace" : undefined,
    );
    expect(process.env.CONFIG_ASYNC_CONFIG).toBeUndefined();
    expect(getRuntimeConfigSnapshot()).toBeNull();
  },
);

it("keeps a pinned runtime readable when the captured launch directory is unavailable", async () => {
  fixture();
  const current = { gateway: { mode: "local" as const, port: 19001 } };
  setRuntimeConfigSnapshot(current);
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw new Error("fixture launch directory removed");
  });
  const config = await withoutMainSql(() =>
    withPluginCache(createPluginCache(), captureRuntimeConfigAsyncReader()),
  );
  expect(config).toBe(current);
  expect(process.env.CONFIG_ASYNC_GLOBAL).toBeUndefined();
  expect(process.env.CONFIG_ASYNC_WORKSPACE).toBeUndefined();
});

it("publishes a config write's fallback reload without main-thread health SQL", async () => {
  const { configPath, state } = fixture();
  const initial = {
    gateway: { mode: "local" as const, port: 18789 },
    env: { vars: { CONFIG_ASYNC_CONFIG: "initial", OPENCLAW_STATE_DIR: state } },
  };
  fs.writeFileSync(configPath, JSON.stringify(initial));
  vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
  prepareConfigRuntimeEnv({ previousConfig: {}, nextConfig: initial }).publish().commit();
  setRuntimeConfigSnapshot(initial, initial);
  const listener = vi.fn();
  const unsubscribe = registerConfigWriteListener(listener);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    await withPluginCache(createPluginCache(), () =>
      writeConfigFile({
        gateway: { mode: "local", port: 19001 },
        env: { vars: { CONFIG_ASYNC_CONFIG: "committed", CONFIG_ASYNC_ADDED: "introduced" } },
      }),
    );
    expect(getRuntimeConfigSnapshot()?.gateway?.port).toBe(19001);
    expect(getRuntimeConfigSourceSnapshot()?.gateway?.port).toBe(19001);
    expect(process.env.CONFIG_ASYNC_CONFIG).toBe("committed");
    expect(process.env.OPENCLAW_STATE_DIR).toBe(state);
    expect(process.env.CONFIG_ASYNC_ADDED).toBe("introduced");
    expect(createManagedRuntimeEnvBase().CONFIG_ASYNC_ADDED).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.port).toBe(19001);
    expect(listener).toHaveBeenCalledOnce();
    expect(
      prepare.mock.calls.filter(
        ([sql]) =>
          /^(select|insert|update|delete)\b/i.test(sql) && sql.includes("config_health_entries"),
      ),
    ).toEqual([]);
  } finally {
    unsubscribe();
    prepare.mockRestore();
  }
});

it.each(["replacement", "disk-only", "cancellation"] as const)(
  "preserves a newer owner's state when fallback reload encounters %s",
  async (change) => {
    const { home, state, configPath } = fixture();
    const initial = { gateway: { mode: "local" as const, port: 18789 } };
    const candidate = { gateway: { mode: "local" as const, port: 19001 } };
    const replacement = {
      gateway: { mode: "local" as const, port: 19002 },
      env: { vars: { CONFIG_ASYNC_CONFIG: "newer-owner" } },
    };
    setRuntimeConfigSnapshot(initial, initial);
    const loading = createDeferredCore();
    const release = createDeferredCore();
    let fallback = false;
    setRuntimeConfigSnapshotRefreshHandler({
      refresh: async () => {
        fs.appendFileSync(path.join(state, ".env"), "CONFIG_ASYNC_FALLBACK=loaded\n");
        fallback = true;
        return false;
      },
    });
    const readFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation((...args) => {
      const read = readFile(...args);
      if (fallback && args[0] === configPath) {
        fallback = false;
        return read.then(async (raw) => {
          loading.resolve();
          await release.promise;
          return raw;
        });
      }
      return read;
    });
    const listener = vi.fn();
    const unsubscribe = registerConfigWriteListener(listener);
    let current = true;
    const pending = withPluginCache(createPluginCache(), () =>
      writeConfigFile(candidate, {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Synthetic config writer retired");
          }
        },
      }),
    );
    const settled = pending.then(
      () => {
        throw new Error("Config write settled before its asynchronous fallback read");
      },
      (error: unknown) => {
        throw error;
      },
    );
    try {
      await Promise.race([loading.promise, settled]);
      expect(getRuntimeConfigSnapshot()).toBe(initial);
      expect(listener).not.toHaveBeenCalled();
      const healthDeps = { env: process.env, homedir: () => home, logger: console };
      const healthBefore = readConfigHealthStateFromStore(healthDeps);
      if (change !== "disk-only") {
        const publication = prepareConfigRuntimeEnv({
          previousConfig: initial,
          nextConfig: replacement,
        }).publish();
        setRuntimeConfigSnapshot(replacement, replacement);
        publication.commit();
        expect(process.env.CONFIG_ASYNC_CONFIG).toBe("newer-owner");
      }
      if (change !== "cancellation") {
        // An external editor can replace the committed bytes while the writer holds its lock.
        fs.writeFileSync(configPath, JSON.stringify(replacement));
      } else {
        current = false;
      }
      const rejected = expect(pending).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        rollbackStatus: change !== "cancellation" ? "not-restored" : "unknown",
      });
      release.resolve();
      await rejected;
      expect(getRuntimeConfigSnapshot()).toBe(change === "disk-only" ? initial : replacement);
      expect(getRuntimeConfigSourceSnapshot()).toBe(change === "disk-only" ? initial : replacement);
      expect(process.env.CONFIG_ASYNC_CONFIG).toBe(
        change === "disk-only" ? undefined : "newer-owner",
      );
      expect(process.env.CONFIG_ASYNC_FALLBACK).toBe("loaded");
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.port).toBe(
        change !== "cancellation" ? 19002 : 19001,
      );
      expect(listener).not.toHaveBeenCalled();
      expect(readConfigHealthStateFromStore(healthDeps)).toEqual(healthBefore);
    } finally {
      release.resolve();
      await Promise.allSettled([pending, settled]);
      unsubscribe();
    }
  },
);
