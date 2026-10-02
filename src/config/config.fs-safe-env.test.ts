import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  getPublishedConfigRuntimeEnvState,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
  resetPublishedConfigRuntimeEnv,
  restoreEnvChangesIfUnchanged,
  snapshotEnv,
} from "./config-env-vars.js";
import type { OpenClawConfig } from "./types.js";

const nativeKey = "OPENCLAW_FS_SAFE_NATIVE_MODE";
const legacyKey = "FS_SAFE_PYTHON_MODE";
const config = (vars: Record<string, string>): OpenClawConfig => ({ env: { vars } });

beforeEach(() => {
  for (const key of [nativeKey, "FS_SAFE_NATIVE_MODE", legacyKey, "OPENCLAW_FS_SAFE_PYTHON_MODE"]) {
    vi.stubEnv(key, undefined);
  }
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});
afterEach(() => {
  clearFsSafeEnvFallback(process.env);
  resetPublishedConfigRuntimeEnv();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function initialize(source: OpenClawConfig) {
  const before = snapshotEnv(process.env);
  applyConfigEnvVars(source);
  initializePublishedConfigRuntimeEnv(source, {
    ownedEnv: collectConfigRuntimeEnvOwnership(source, before, process.env),
  });
}

describe("config-owned fs-safe mode migration", () => {
  it("lets a later native config value beat an inherited legacy mode and restores fallback on removal", () => {
    process.env[legacyKey] = "off";
    normalizeFsSafeNativeEnv();
    const source = config({ [nativeKey]: "require" });
    initialize(source);
    expect(process.env[nativeKey]).toBe("require");
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({ [nativeKey]: "require" });

    const removal = prepareConfigRuntimeEnv({ previousConfig: source, nextConfig: {} }).publish();
    removal.commit();
    expect(process.env[nativeKey]).toBe("off");
    expect(fsSafeEnvInput(process.env)[nativeKey]).toBeUndefined();
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({});
  });

  it("owns only the legacy input and removes the derived mode with its config", () => {
    const source = config({ [legacyKey]: " Required " });
    initialize(source);
    expect(process.env[nativeKey]).toBe(" Required ");
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({ [legacyKey]: " Required " });
    const removal = prepareConfigRuntimeEnv({ previousConfig: source, nextConfig: {} }).publish();
    expect(process.env[legacyKey]).toBeUndefined();
    expect(process.env[nativeKey]).toBeUndefined();
    removal();
    expect(process.env[legacyKey]).toBe(" Required ");
    expect(process.env[nativeKey]).toBe(" Required ");
    expect(fsSafeEnvInput(process.env)[nativeKey]).toBeUndefined();
  });

  it("restores legacy fallback after a rejected native publication without adopting it", () => {
    const source = config({ [legacyKey]: "require" });
    initialize(source);
    const replacement = prepareConfigRuntimeEnv({
      previousConfig: source,
      nextConfig: config({ [nativeKey]: "off" }),
    }).publish();
    expect(process.env[nativeKey]).toBe("off");
    expect(process.env[legacyKey]).toBeUndefined();
    replacement();
    expect(process.env[nativeKey]).toBe("require");
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({ [legacyKey]: "require" });
    prepareConfigRuntimeEnv({ previousConfig: source, nextConfig: {} }).publish().commit();
    expect(process.env[nativeKey]).toBeUndefined();
  });

  it("distinguishes an equal-byte native config value from an earlier derived fallback", () => {
    process.env[legacyKey] = "off";
    normalizeFsSafeNativeEnv();
    const source = config({ [nativeKey]: "off" });
    initialize(source);
    expect(fsSafeEnvInput(process.env)[nativeKey]).toBe("off");
    delete process.env[legacyKey];
    normalizeFsSafeNativeEnv();
    expect(process.env[nativeKey]).toBe("off");
    expect(getPublishedConfigRuntimeEnvState().ownedEnv).toEqual({ [nativeKey]: "off" });
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
