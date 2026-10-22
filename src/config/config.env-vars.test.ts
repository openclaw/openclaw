import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "../infra/dotenv.js";
import {
  clearFsSafeEnvFallback,
  fsSafeEnvInput,
  normalizeFsSafeNativeEnv,
} from "../infra/fs-safe-env.js";
import {
  applyConfigEnvVars,
  captureConfigReadEnvMutation,
  cloneEnvWithPlatformSemantics,
  collectConfigRuntimeEnvOwnership,
  createConfigRuntimeEnv,
  getPublishedConfigRuntimeEnvState as publishedEnv,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv as prepareEnv,
  prepareConfigRuntimeEnvLoad as stageLoad,
  resetPublishedConfigRuntimeEnv,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
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
const windows = () => vi.spyOn(process, "platform", "get").mockReturnValue("win32");
function applied(source: OpenClawConfig) {
  const env = {};
  applyConfigEnvVars(source, env);
  return env;
}

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
    expect(
      applied({
        env: {
          OpenClaw_Config_ReadOnly: "1",
          vars: {
            ...Object.fromEntries(
              `OPENCLAW_CONFIG_READONLY BASH_ENV SHELL HOME ZDOTDIR
               OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS
               openclaw_allow_older_binary_destructive_actions OPENCLAW_INCLUDE_ROOTS`
                .split(/\s+/)
                .map((name) => [name, "/tmp/blocked"]),
            ),
            OPENCLAW_DISABLE_GATEWAY_LOCAL_TERMINALS: "0",
            OPENCLAW_DISABLE_CRON_HOST_EXECUTION: "0",
            OPENCLAW_NIX_MODE: "1",
            VALID: "literal",
          },
        },
      }),
    ).toEqual({ OPENCLAW_NIX_MODE: "1", VALID: "literal" });
  });

  it("ignores malformed config env entries", () => {
    expect(
      applied(
        JSON.parse(
          '{"env":{"NOT-PORTABLE":"bad","vars":{" BAD KEY":"bad","PORT":8080,"DEBUG":true,"EMPTY":"","VALID":"literal"}}}',
        ),
      ),
    ).toEqual({ VALID: "literal" });
  });

  it("does not apply unresolved references with or without defaults", () => {
    expect(
      applied(
        config({ BARE_REF: "${SOME_VAR}", DEFAULT_REF: "${SOME_VAR:-fallback}", VALID: "literal" }),
      ),
    ).toEqual({ VALID: "literal" });
  });

  it("prepares updates and removals without mutating the target or rescanning per key", () => {
    const env = { UPDATE_ME: "old", REMOVE_ME: "owned", KEEP_OVERRIDE: "ambient" };
    const prepared = prepareEnv({
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

  it("keeps same-valued dotenv and shell entries ambient when staged config is removed", () => {
    const previousConfig = initialize();
    const stage = stageLoad({ previousConfig });
    stage.env[dotenvKey] = "shared";
    stage.captureDotEnvBaseline();
    const nextConfig = config({ [dotenvKey]: "shared", [key]: "config" });
    applyConfigEnvVars(nextConfig, stage.env);
    stage.env[shellKey] = "shell";
    stage.prepare(nextConfig).publish().commit();
    expect(publishedEnv().ownedEnv).toEqual({ [key]: "config" });
    expect(publishedEnv().sourceConfig).toBe(nextConfig);
    prepareEnv({ previousConfig: nextConfig, nextConfig: {} }).publish().commit();
    expect([process.env[key], process.env[dotenvKey], process.env[shellKey]]).toEqual([
      undefined,
      "shared",
      "shell",
    ]);
  });

  it("publishes only captured dotenv after failed loading and preserves prior ownership", () => {
    const previousConfig = initialize({ [key]: "previous" });
    vi.stubEnv("OPENCLAW_TEST_FAILED_CONFIG", undefined);
    const previousOwnership = publishedEnv().ownedEnv;
    const stage = stageLoad({ previousConfig });
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
    expect(publishedEnv().ownedEnv).toBe(previousOwnership);
    expect(publishedEnv().sourceConfig).toBe(previousConfig);
    rollback();
    expect([process.env[dotenvKey], process.env[key]]).toEqual([undefined, "previous"]);
    expect(publishedEnv().ownedEnv).toBe(previousOwnership);
    expect(publishedEnv().sourceConfig).toBe(previousConfig);
  });

  it("retains live overrides during isolated loading and after publication", () => {
    const env: NodeJS.ProcessEnv = { CONFIG_VALUE: "old" };
    const stage = stageLoad({
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

  it("rejects process-stable Gateway selector changes during reload", () => {
    expect(() =>
      assertGatewayConfigEnvSelectionUnchanged({}, config({ OPENCLAW_CONFIG_PATH: "1" })),
    ).toThrow("process-stable Gateway selector OPENCLAW_CONFIG_PATH");
  });

  it("restores the last committed config environment after a rejected replacement", () => {
    const previousConfig = initialize();
    const acceptedConfig = config({ [key]: "accepted" });
    prepareEnv({ previousConfig, nextConfig: acceptedConfig }).publish().commit();
    const replacement = prepareEnv({
      previousConfig: acceptedConfig,
      nextConfig: config({ [key]: "rejected" }),
    }).publish();
    expect(process.env[key]).toBe("rejected");

    replacement();
    expect(process.env[key]).toBe("accepted");
    expect(publishedEnv()).toMatchObject({
      sourceConfig: acceptedConfig,
      ownedEnv: { [key]: "accepted" },
    });
  });

  it("preserves Windows case-insensitive precedence in a merged runtime env", () => {
    windows();
    const merged = createConfigRuntimeEnv(config({ OPENCLAW_LOAD_SHELL_ENV: "1" }), {
      OpenClaw_Load_Shell_Env: "0",
    });
    expect(merged.OPENCLAW_LOAD_SHELL_ENV).toBe("0");
    expect(Object.keys(merged)).toEqual(["OpenClaw_Load_Shell_Env"]);
  });

  it.each([false, true])(
    "rolls back Windows spelling unless concurrently renamed: %s",
    (concurrent) => {
      windows();
      const env: NodeJS.ProcessEnv = { Config_Value: "old" };
      const prepared = prepareEnv({
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
    windows();
    const concurrentKey = key.toLowerCase();
    vi.stubEnv(concurrentKey, undefined);
    const previousConfig = initialize({ [key]: "owned" });
    const unchanged = prepareEnv({ previousConfig, nextConfig: previousConfig });
    delete process.env[key];
    process.env[concurrentKey] = "owned";
    unchanged.publish().commit();
    prepareEnv({ previousConfig, nextConfig: {} }).publish().commit();
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
      loadDotEnv();
      expect(resolveConfigEnvVars(cfg, process.env)).toEqual(expected);
      delete process.env.BRAVE_API_KEY;
      loadDotEnv();
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
    const prepared = prepareEnv({
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

describe("config-owned fs-safe mode migration", () => {
  const nativeKey = "OPENCLAW_FS_SAFE_NATIVE_MODE";
  const legacyKey = "FS_SAFE_PYTHON_MODE";

  beforeEach(() => {
    for (const name of [
      nativeKey,
      "FS_SAFE_NATIVE_MODE",
      legacyKey,
      "OPENCLAW_FS_SAFE_PYTHON_MODE",
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  });
  afterEach(() => clearFsSafeEnvFallback(process.env));

  it("restores legacy fallback after a rejected native publication without adopting it", () => {
    const source = config({ [legacyKey]: "require" });
    const before = snapshotEnv(process.env);
    applyConfigEnvVars(source);
    initializePublishedConfigRuntimeEnv(source, {
      ownedEnv: collectConfigRuntimeEnvOwnership(source, before, process.env),
    });
    const replacement = prepareEnv({
      previousConfig: source,
      nextConfig: config({ [nativeKey]: "off" }),
    }).publish();
    expect([process.env[nativeKey], process.env[legacyKey]]).toEqual(["off", undefined]);
    replacement();
    expect(process.env[nativeKey]).toBe("require");
    expect(publishedEnv().ownedEnv).toEqual({ [legacyKey]: "require" });
    prepareEnv({ previousConfig: source, nextConfig: {} }).publish().commit();
    expect(process.env[nativeKey]).toBeUndefined();
  });

  it("recomputes isolated candidates without changing their parent's legacy projection", () => {
    const env: NodeJS.ProcessEnv = { [legacyKey]: "off" };
    normalizeFsSafeNativeEnv(env);
    const clone = cloneEnvWithPlatformSemantics(env);
    applyConfigEnvVars(config({ [nativeKey]: "require" }), clone);
    expect(clone[nativeKey]).toBe("require");
    expect(env[nativeKey]).toBe("off");
    expect(fsSafeEnvInput(env)[nativeKey]).toBeUndefined();
  });

  it("restores invalid native input after a rejected config read introduced legacy mode", () => {
    const env: NodeJS.ProcessEnv = { [nativeKey]: "invalid" };
    const before = snapshotEnv(env);
    applyConfigEnvVars(config({ [legacyKey]: "require" }), env);
    expect(env[nativeKey]).toBe("require");
    restoreEnvChangesIfUnchanged({ env, before, after: snapshotEnv(env) });
    expect(env).toEqual({ [nativeKey]: "invalid" });
  });

  it("compensates synchronous read mutations using source keys, preserving later operator changes", () => {
    const env: NodeJS.ProcessEnv = {};
    let restore: (() => void) | undefined;
    captureConfigReadEnvMutation(
      env,
      () => applyConfigEnvVars(config({ [legacyKey]: "off" }), env),
      (receipt) => {
        restore = receipt;
      },
    );
    expect(env[nativeKey]).toBe("off");
    env.FS_SAFE_NATIVE_MODE = "require";
    restore?.();
    expect(env).toEqual({ FS_SAFE_NATIVE_MODE: "require" });
  });
});
