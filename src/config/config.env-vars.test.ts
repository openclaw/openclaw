import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import {
  applyConfigEnvVars,
  collectConfigRuntimeEnvOwnership,
  createConfigRuntimeEnv,
  getPublishedConfigRuntimeEnvState,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
  prepareConfigRuntimeEnvLoad,
  resetPublishedConfigRuntimeEnv,
} from "./config-env-vars.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import { assertGatewayConfigEnvSelectionUnchanged } from "./gateway-env-selection.js";
import { collectDurableServiceEnvVars } from "./state-dir-dotenv.js";
import { withTempHome, writeStateDirDotEnv } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

const key = "OPENCLAW_TEST_ENV";
const dotenvKey = "OPENCLAW_TEST_DOTENV";
const shellKey = "OPENCLAW_TEST_SHELL";
const config = (vars: Record<string, string>): OpenClawConfig => ({ env: { vars } });

function initialize(ownedEnv: Record<string, string> = {}) {
  for (const name of [key, dotenvKey, shellKey]) {
    vi.stubEnv(name, ownedEnv[name]);
  }
  const previousConfig = config(ownedEnv);
  initializePublishedConfigRuntimeEnv(previousConfig, { ownedEnv });
  return previousConfig;
}

function captureEnvEnumerations<T>(env: NodeJS.ProcessEnv, run: () => T) {
  const entries = Object.entries;
  const cardinalities: number[] = [];
  const spy = vi.spyOn(Object, "entries").mockImplementation((value) => {
    const result = entries(value);
    if (value === env) {
      cardinalities.push(result.length);
    }
    return result;
  });
  try {
    return { value: run(), cardinalities };
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  resetPublishedConfigRuntimeEnv();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("config env vars", () => {
  it("blocks config-owned host controls and startup env vars", () => {
    const env: NodeJS.ProcessEnv = {};
    applyConfigEnvVars(
      {
        env: {
          OpenClaw_Config_ReadOnly: "1",
          vars: {
            OPENCLAW_CONFIG_READONLY: "1",
            BASH_ENV: "/tmp/pwn.sh",
            SHELL: "/tmp/evil-shell",
            HOME: "/tmp/evil-home",
            ZDOTDIR: "/tmp/evil-zdotdir",
            OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
            openclaw_allow_older_binary_destructive_actions: "1",
            OPENCLAW_INCLUDE_ROOTS: "/tmp/evil-include-root",
            OPENCLAW_NIX_MODE: "1",
            VALID: "literal",
          },
        },
      },
      env,
    );
    expect(env).toEqual({ OPENCLAW_NIX_MODE: "1", VALID: "literal" });
  });

  it("ignores malformed config env entries", () => {
    const env: NodeJS.ProcessEnv = {};
    applyConfigEnvVars(
      JSON.parse(`{
      "env": {"NOT-PORTABLE": "bad", "vars": {
        " BAD KEY": "bad", "PORT": 8080, "DEBUG": true, "EMPTY": "", "VALID": "literal"
      }}
    }`),
      env,
    );
    expect(env).toEqual({ VALID: "literal" });
  });

  it("does not apply unresolved references with or without defaults", () => {
    const env: NodeJS.ProcessEnv = {};
    applyConfigEnvVars(
      config({ BARE_REF: "${SOME_VAR}", DEFAULT_REF: "${SOME_VAR:-fallback}", VALID: "literal" }),
      env,
    );
    expect(env).toEqual({ VALID: "literal" });
  });

  it("applies config env above normalized lower-precedence aliases", () => {
    const replaced = vi.fn();
    const env = { ZAI_API_KEY: "shell-key" };
    applyConfigEnvVars(config({ Z_AI_API_KEY: "config-key" }), env, {
      lowerPrecedenceEnv: { ZAI_API_KEY: "shell-key" },
      onLowerPrecedenceKeysReplaced: replaced,
    });
    expect(env).toEqual({ ZAI_API_KEY: "config-key", Z_AI_API_KEY: "config-key" });
    expect(replaced).toHaveBeenCalledWith(["ZAI_API_KEY"]);
  });

  it("preserves a higher-precedence normalized alias", () => {
    const env = { ZAI_API_KEY: "shell-key", Z_AI_API_KEY: "invocation-key" };
    applyConfigEnvVars(config({ ZAI_API_KEY: "config-key" }), env, {
      lowerPrecedenceEnv: { ZAI_API_KEY: "shell-key" },
    });
    expect(env).toEqual({ ZAI_API_KEY: "invocation-key", Z_AI_API_KEY: "invocation-key" });
  });

  it("prepares updates and removals without mutating the target or rescanning per key", () => {
    const env = { UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" };
    const prepared = prepareConfigRuntimeEnv({
      previousConfig: config({ UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "owned" }),
      nextConfig: config({ UPDATE_ME: "new" }),
      env,
      previousOwnedEnv: { UPDATE_ME: "old", REMOVE_ME: "owned" },
    });
    expect(env).toEqual({ UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" });
    expect(prepared.env).toEqual({ UPDATE_ME: "new", KEEP_OVERRIDE: "ambient" });
    const publication = captureEnvEnumerations(env, () => prepared.publish());
    expect(env).toEqual({ UPDATE_ME: "new", KEEP_OVERRIDE: "ambient" });
    const rollback = captureEnvEnumerations(env, publication.value);
    expect(env).toEqual({ UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" });
    expect(publication.cardinalities).toEqual([3]);
    expect(rollback.cardinalities).toEqual([2]);
  });

  it("publishes late loader changes from a detached final snapshot", () => {
    const env: NodeJS.ProcessEnv = { AMBIENT: "original" };
    const stage = prepareConfigRuntimeEnvLoad({ previousConfig: {}, env });
    stage.env.DOTENV_VALUE = "dotenv";
    stage.captureDotEnvBaseline();
    const nextConfig = config({ CONFIG_VALUE: "config" });
    applyConfigEnvVars(nextConfig, stage.env);
    stage.env.SHELL_VALUE = "shell";
    const prepared = stage.prepare(nextConfig);
    stage.env.CONFIG_VALUE = "changed after preparation";
    expect(env).toEqual({ AMBIENT: "original" });
    const rollback = prepared.publish();
    expect(env).toEqual({
      AMBIENT: "original",
      DOTENV_VALUE: "dotenv",
      CONFIG_VALUE: "config",
      SHELL_VALUE: "shell",
    });
    rollback();
    expect(env).toEqual({ AMBIENT: "original" });
  });

  it("keeps same-valued dotenv and shell entries ambient when staged config is removed", () => {
    const previousConfig = initialize();
    const stage = prepareConfigRuntimeEnvLoad({ previousConfig });
    stage.env[dotenvKey] = "shared";
    stage.captureDotEnvBaseline();
    const nextConfig = config({ [dotenvKey]: "shared", [key]: "config" });
    applyConfigEnvVars(nextConfig, stage.env);
    stage.env[shellKey] = "shell";
    stage.prepare(nextConfig).publish().commit();
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({ [key]: "config" });
    expect(getPublishedConfigRuntimeEnvState().sourceConfig).toBe(nextConfig);
    prepareConfigRuntimeEnv({ previousConfig: nextConfig, nextConfig: {} }).publish().commit();
    expect(process.env[key]).toBeUndefined();
    expect(process.env[dotenvKey]).toBe("shared");
    expect(process.env[shellKey]).toBe("shell");
  });

  it("publishes only captured dotenv after failed loading and preserves prior ownership", () => {
    const previousConfig = initialize({ [key]: "previous" });
    vi.stubEnv("OPENCLAW_TEST_FAILED_CONFIG", undefined);
    const previousOwnership = getPublishedConfigRuntimeEnvState().ownedEnv;
    const stage = prepareConfigRuntimeEnvLoad({ previousConfig });
    stage.env[dotenvKey] = "loaded before failure";
    stage.captureDotEnvBaseline();
    applyConfigEnvVars(
      config({ [key]: "candidate", OPENCLAW_TEST_FAILED_CONFIG: "candidate" }),
      stage.env,
    );
    stage.env[shellKey] = "candidate shell";
    stage.env[dotenvKey] = "later config mutation";
    const rollback = stage.prepareFailure().publish();
    expect(process.env[key]).toBe("previous");
    expect(process.env[dotenvKey]).toBe("loaded before failure");
    expect(process.env.OPENCLAW_TEST_FAILED_CONFIG).toBeUndefined();
    expect(process.env[shellKey]).toBeUndefined();
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toBe(previousOwnership);
    expect(getPublishedConfigRuntimeEnvState().sourceConfig).toBe(previousConfig);
    rollback();
    expect(process.env[dotenvKey]).toBeUndefined();
    expect(process.env[key]).toBe("previous");
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toBe(previousOwnership);
    expect(getPublishedConfigRuntimeEnvState().sourceConfig).toBe(previousConfig);
  });

  it("retains live overrides during isolated loading and after publication", () => {
    const env: NodeJS.ProcessEnv = { CONFIG_VALUE: "old" };
    const stage = prepareConfigRuntimeEnvLoad({
      previousConfig: config({ CONFIG_VALUE: "old" }),
      previousOwnedEnv: { CONFIG_VALUE: "old" },
      env,
    });
    stage.captureDotEnvBaseline();
    const nextConfig = config({ CONFIG_VALUE: "candidate", ADDED_VALUE: "added" });
    applyConfigEnvVars(nextConfig, stage.env);
    env.CONFIG_VALUE = "external during load";
    const rollback = stage.prepare(nextConfig).publish();
    expect(env).toEqual({ CONFIG_VALUE: "external during load", ADDED_VALUE: "added" });
    env.ADDED_VALUE = "external after publish";
    rollback();
    expect(env).toEqual({
      CONFIG_VALUE: "external during load",
      ADDED_VALUE: "external after publish",
    });
  });

  it("unwinds staged config behind a later failed-loader dotenv publication", () => {
    const previousConfig = initialize({ [key]: "original" });
    const nextConfig = config({ [key]: "candidate" });
    const older = prepareConfigRuntimeEnvLoad({ previousConfig });
    older.captureDotEnvBaseline();
    applyConfigEnvVars(nextConfig, older.env);
    const rollbackOlder = older.prepare(nextConfig).publish();
    const newer = prepareConfigRuntimeEnvLoad({ previousConfig: {} });
    newer.env[dotenvKey] = "dotenv";
    newer.captureDotEnvBaseline();
    newer.env[key] = "discarded loader mutation";
    const rollbackNewer = newer.prepareFailure().publish();
    rollbackOlder();
    expect(process.env[key]).toBe("candidate");
    expect(process.env[dotenvKey]).toBe("dotenv");
    expect(getPublishedConfigRuntimeEnvState().sourceConfig).toBe(nextConfig);
    rollbackNewer();
    expect(process.env[key]).toBe("original");
    expect(process.env[dotenvKey]).toBeUndefined();
    expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
      sourceConfig: previousConfig,
      ownedEnv: { [key]: "original" },
    });
  });

  it.each([
    { first: "new", second: "new", olderFirst: true },
    { first: "older", second: "newer", olderFirst: true },
    { first: "older", second: "newer", olderFirst: false },
  ])(
    "unwinds $first/$second publications, olderFirst=$olderFirst",
    ({ first, second, olderFirst }) => {
      const previousConfig = initialize({ [key]: "old" });
      const older = prepareConfigRuntimeEnv({
        previousConfig,
        nextConfig: config({ [key]: first }),
      });
      const newer = prepareConfigRuntimeEnv({
        previousConfig,
        nextConfig: config({ [key]: second }),
      });
      const a = captureEnvEnumerations(process.env, () => older.publish());
      const b = captureEnvEnumerations(process.env, () => newer.publish());
      expect(process.env[key]).toBe(second);
      const firstRollback = captureEnvEnumerations(process.env, olderFirst ? a.value : b.value);
      expect(process.env[key]).toBe(olderFirst ? second : first);
      const secondRollback = captureEnvEnumerations(process.env, olderFirst ? b.value : a.value);
      expect(process.env[key]).toBe("old");
      expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
        ownedEnv: { [key]: "old" },
        sourceConfig: previousConfig,
      });
      expect(a.cardinalities).toHaveLength(2);
      expect(b.cardinalities).toHaveLength(2);
      expect([firstRollback.cardinalities.length, secondRollback.cardinalities.length]).toEqual(
        olderFirst ? [0, 2] : [1, 1],
      );
    },
  );

  it.each<{
    before: Record<string, string>;
    next: Record<string, string>;
    expected: string | undefined;
  }>([
    { before: { [key]: "old" }, next: { [key]: "newer" }, expected: "newer" },
    { before: {}, next: {}, expected: undefined },
  ])("committed successor supersedes late rollback: $expected", ({ before, next, expected }) => {
    const previousConfig = initialize(before);
    const nextConfig = config(next);
    const older = prepareConfigRuntimeEnv({
      previousConfig,
      nextConfig: config({ [key]: "added" }),
    });
    const newer = prepareConfigRuntimeEnv({ previousConfig, nextConfig });
    const rollbackOlder = older.publish();
    const committed = newer.publish();
    expect(process.env[key]).toBe(expected);
    committed.commit();
    rollbackOlder();
    expect(process.env[key]).toBe(expected);
    expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
      ownedEnv: next,
      sourceConfig: nextConfig,
    });
  });

  it("rejects process-stable Gateway selector changes during reload", () => {
    expect(() =>
      assertGatewayConfigEnvSelectionUnchanged({}, config({ OPENCLAW_CONFIG_PATH: "1" })),
    ).toThrow("process-stable Gateway selector OPENCLAW_CONFIG_PATH");
  });

  it("preserves Windows case-insensitive precedence in a merged runtime env", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const merged = createConfigRuntimeEnv(config({ OPENCLAW_LOAD_SHELL_ENV: "1" }), {
      OpenClaw_Load_Shell_Env: "0",
    });
    expect(merged.OPENCLAW_LOAD_SHELL_ENV).toBe("0");
    expect(Object.keys(merged)).toEqual(["OpenClaw_Load_Shell_Env"]);
  });

  it.each([false, true])(
    "rolls back Windows spelling unless concurrently renamed: %s",
    (concurrent) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const env: NodeJS.ProcessEnv = { Config_Value: "old" };
      const prepared = prepareConfigRuntimeEnv({
        previousConfig: config({ Config_Value: "old" }),
        nextConfig: config({ CONFIG_VALUE: concurrent ? "new" : "old" }),
        env,
        previousOwnedEnv: { Config_Value: "old" },
      });
      const rollback = prepared.publish();
      expect(env).toEqual({ CONFIG_VALUE: concurrent ? "new" : "old" });
      if (concurrent) {
        delete env.CONFIG_VALUE;
        env.config_value = "new";
      }
      rollback();
      expect(env).toEqual(concurrent ? { config_value: "new" } : { Config_Value: "old" });
    },
  );

  it("does not adopt a concurrent Windows case-only rename as config-owned", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const concurrentKey = key.toLowerCase();
    vi.stubEnv(concurrentKey, undefined);
    const previousConfig = initialize({ [key]: "owned" });
    const unchanged = prepareConfigRuntimeEnv({ previousConfig, nextConfig: previousConfig });
    delete process.env[key];
    process.env[concurrentKey] = "owned";
    unchanged.publish().commit();
    prepareConfigRuntimeEnv({ previousConfig, nextConfig: {} }).publish().commit();
    expect(process.env[concurrentKey]).toBe("owned");
  });

  it("reloads state-dir dotenv substitutions after the environment is cleared", async () => {
    await withTempHome(async () => {
      vi.stubEnv("BRAVE_API_KEY", undefined);
      await writeStateDirDotEnv("BRAVE_API_KEY=from-dotenv\n", { env: process.env });
      const cfg = {
        plugins: { entries: { brave: { config: { webSearch: { apiKey: "${BRAVE_API_KEY}" } } } } },
      };
      const expected = {
        plugins: { entries: { brave: { config: { webSearch: { apiKey: "from-dotenv" } } } } },
      };
      loadDotEnv({ quiet: true });
      expect(resolveConfigEnvVars(cfg, process.env)).toEqual(expected);
      delete process.env.BRAVE_API_KEY;
      loadDotEnv({ quiet: true });
      expect(resolveConfigEnvVars(cfg, process.env)).toEqual(expected);
    });
  });

  it("filters dangerous and empty durable service env values", async () => {
    await withTempHome(async () => {
      await writeStateDirDotEnv(
        "NODE_OPTIONS=--require /tmp/evil.js\nOPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1\nEMPTY=\nVALID=ok\n",
        { env: process.env },
      );
      expect(collectDurableServiceEnvVars({ env: process.env })).toEqual({ VALID: "ok" });
    });
  });

  it("tracks equal lower-precedence replacements as owned across reload", () => {
    const previousConfig = config({ [key]: "shared" });
    const env = { [key]: "shared" };
    const before = { ...env };
    const replacedLowerPrecedenceKeys: string[] = [];
    applyConfigEnvVars(previousConfig, env, {
      lowerPrecedenceEnv: before,
      onLowerPrecedenceKeysReplaced: (keys) => replacedLowerPrecedenceKeys.push(...keys),
    });
    const ownedEnv = collectConfigRuntimeEnvOwnership(previousConfig, before, env, {
      replacedLowerPrecedenceKeys,
    });
    const prepared = prepareConfigRuntimeEnv({
      previousConfig,
      nextConfig: config({ [key]: "next" }),
      env,
      previousOwnedEnv: ownedEnv,
    });
    expect(replacedLowerPrecedenceKeys).toEqual([key]);
    expect(ownedEnv).toEqual({ [key]: "shared" });
    expect(prepared.env[key]).toBe("next");
  });

  it("lets config override dotenv from the selected state directory", async () => {
    await withTempHome(async () => {
      const stateDir = path.join(process.env.OPENCLAW_STATE_DIR ?? "", "custom-state");
      await writeStateDirDotEnv("MY_KEY=from-dotenv\nCUSTOM_KEY=from-override\n", { stateDir });
      expect(
        collectDurableServiceEnvVars({
          env: { OPENCLAW_STATE_DIR: stateDir },
          config: config({ MY_KEY: "from-config" }),
        }),
      ).toEqual({ MY_KEY: "from-config", CUSTOM_KEY: "from-override" });
    });
  });
});
