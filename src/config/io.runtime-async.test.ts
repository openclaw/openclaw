import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import { readConfigHealthStateFromStore } from "./io.health-state.js";
import { captureRuntimeConfigAsyncReader } from "./io.runtime.js";
import {
  getRuntimeConfigSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "./runtime-snapshot.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetConfigRuntimeState();
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

it("loads and pins default config with real staged dotenv and health without main SQL", async () => {
  const { home, state, configPath } = fixture({
    gateway: { mode: "local", auth: { mode: "token", token: "${CONFIG_ASYNC_GLOBAL}" } },
    env: { vars: { CONFIG_ASYNC_CONFIG: "config" } },
  });
  await withPluginCache(createPluginCache(), async () => {
    const read = captureRuntimeConfigAsyncReader();
    expect(process.env.CONFIG_ASYNC_WORKSPACE).toBeUndefined();
    expect(getRuntimeConfigSnapshot()).toBeNull();
    const config = await withoutMainSql(read);
    expect(config.gateway?.auth?.token).toBe("global");
    expect(config.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(getRuntimeConfigSnapshot()).toBe(config);
    expect(await read()).toBe(config);
    expect(process.env.CONFIG_ASYNC_WORKSPACE).toBe("workspace");
    expect(process.env.CONFIG_ASYNC_GLOBAL).toBe("global");
    expect(process.env.CONFIG_ASYNC_CONFIG).toBe("config");
  });
  expect(
    readConfigHealthStateFromStore({
      env: { HOME: home, OPENCLAW_STATE_DIR: state },
      homedir: () => home,
      logger: console,
    }).entries?.[configPath]?.lastKnownGood,
  ).toBeDefined();
});

it("keeps the root path selected before trusted dotenv publishes a config selector", async () => {
  const { state } = fixture();
  const other = path.join(state, "other.json");
  fs.writeFileSync(other, JSON.stringify({ gateway: { mode: "local", port: 19001 } }));
  fs.writeFileSync(path.join(state, ".env"), `OPENCLAW_CONFIG_PATH=${other}\n`);
  const read = captureRuntimeConfigAsyncReader();
  const config = await withoutMainSql(() => withPluginCache(createPluginCache(), read));
  expect(config.gateway?.port).toBe(18789);
  expect(process.env.OPENCLAW_CONFIG_PATH).toBe(other);
  expect(getRuntimeConfigSnapshot()).toBe(config);
  expect(() => read.assertCurrent()).not.toThrow();
});

it("retains dotenv but rejects config-owned environment when strict validation fails", async () => {
  fixture({ gateway: { port: "invalid" }, env: { vars: { CONFIG_ASYNC_CONFIG: "rejected" } } });
  await expect(
    withoutMainSql(() => withPluginCache(createPluginCache(), captureRuntimeConfigAsyncReader())),
  ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  expect(process.env.CONFIG_ASYNC_WORKSPACE).toBe("workspace");
  expect(process.env.CONFIG_ASYNC_GLOBAL).toBe("global");
  expect(process.env.CONFIG_ASYNC_CONFIG).toBeUndefined();
  expect(getRuntimeConfigSnapshot()).toBeNull();
});

it("does not load a different ambient namespace after the reader was captured", async () => {
  fixture();
  const read = captureRuntimeConfigAsyncReader();
  expect(() => read.assertCurrent()).not.toThrow();
  vi.stubEnv("OPENCLAW_CONFIG_PATH", "/fixture/another-config.json");
  expect(() => read.assertCurrent()).toThrow("Runtime config source changed");
  await expect(withoutMainSql(() => Promise.resolve().then(read))).rejects.toThrow(
    "Runtime config source changed",
  );
  expect(process.env.CONFIG_ASYNC_WORKSPACE).toBeUndefined();
  expect(getRuntimeConfigSnapshot()).toBeNull();
});

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
