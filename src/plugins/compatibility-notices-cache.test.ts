import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readCompatibilityNoticesCache,
  resolveCompatibilityNoticesCacheKey,
  resolveCompatibilityNoticesCachePath,
  writeCompatibilityNoticesCache,
} from "./compatibility-notices-cache.js";
import type { PluginCompatibilityNotice } from "./status.js";

const SAMPLE_NOTICES: PluginCompatibilityNotice[] = [
  {
    pluginId: "demo",
    code: "legacy-before-agent-start",
    severity: "warn",
    message:
      "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
  },
  {
    pluginId: "demo",
    code: "hook-only",
    severity: "info",
    message:
      "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
  },
];

const CACHE_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.4.20",
};

const CONFIG_A: OpenClawConfig = {
  plugins: {
    entries: {
      demo: { enabled: true },
    },
  },
} as OpenClawConfig;

const CONFIG_B: OpenClawConfig = {
  plugins: {
    entries: {
      demo: { enabled: false },
    },
  },
} as OpenClawConfig;

describe("compatibility-notices-cache", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = syncFs.mkdtempSync(path.join(os.tmpdir(), "openclaw-compat-cache-"));
  });

  afterEach(() => {
    syncFs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("resolves a stable sha256 cache key for the same inputs", () => {
    const key1 = resolveCompatibilityNoticesCacheKey({ config: CONFIG_A, env: CACHE_ENV });
    const key2 = resolveCompatibilityNoticesCacheKey({ config: CONFIG_A, env: CACHE_ENV });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the cache key when plugins config changes", () => {
    const key1 = resolveCompatibilityNoticesCacheKey({ config: CONFIG_A, env: CACHE_ENV });
    const key2 = resolveCompatibilityNoticesCacheKey({ config: CONFIG_B, env: CACHE_ENV });
    expect(key1).not.toBe(key2);
  });

  it("changes the cache key when openclaw host version changes", () => {
    const key1 = resolveCompatibilityNoticesCacheKey({ config: CONFIG_A, env: CACHE_ENV });
    const key2 = resolveCompatibilityNoticesCacheKey({
      config: CONFIG_A,
      env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: "2099.1.1" },
    });
    expect(key1).not.toBe(key2);
  });

  it("returns null when no cache file exists", () => {
    expect(
      readCompatibilityNoticesCache({ config: CONFIG_A, env: CACHE_ENV, workspaceDir }),
    ).toBeNull();
  });

  it("round-trips notices through the cache file", () => {
    writeCompatibilityNoticesCache({
      config: CONFIG_A,
      env: CACHE_ENV,
      workspaceDir,
      notices: SAMPLE_NOTICES,
    });
    const read = readCompatibilityNoticesCache({
      config: CONFIG_A,
      env: CACHE_ENV,
      workspaceDir,
    });
    expect(read).toEqual(SAMPLE_NOTICES);
  });

  it("invalidates the cache when config changes between write and read", () => {
    writeCompatibilityNoticesCache({
      config: CONFIG_A,
      env: CACHE_ENV,
      workspaceDir,
      notices: SAMPLE_NOTICES,
    });
    const read = readCompatibilityNoticesCache({
      config: CONFIG_B,
      env: CACHE_ENV,
      workspaceDir,
    });
    expect(read).toBeNull();
  });

  it("returns null when the cache file is corrupt", () => {
    const filePath = resolveCompatibilityNoticesCachePath({ workspaceDir, env: CACHE_ENV });
    syncFs.mkdirSync(path.dirname(filePath), { recursive: true });
    syncFs.writeFileSync(filePath, "{ not valid json ", { encoding: "utf-8" });
    expect(
      readCompatibilityNoticesCache({ config: CONFIG_A, env: CACHE_ENV, workspaceDir }),
    ).toBeNull();
  });

  it("returns null when the envelope version does not match", () => {
    const filePath = resolveCompatibilityNoticesCachePath({ workspaceDir, env: CACHE_ENV });
    syncFs.mkdirSync(path.dirname(filePath), { recursive: true });
    const key = resolveCompatibilityNoticesCacheKey({ config: CONFIG_A, env: CACHE_ENV });
    syncFs.writeFileSync(filePath, JSON.stringify({ version: 999, key, notices: SAMPLE_NOTICES }), {
      encoding: "utf-8",
    });
    expect(
      readCompatibilityNoticesCache({ config: CONFIG_A, env: CACHE_ENV, workspaceDir }),
    ).toBeNull();
  });

  it("skips read and write when OPENCLAW_COMPAT_CACHE=0", () => {
    const disabledEnv: NodeJS.ProcessEnv = { ...CACHE_ENV, OPENCLAW_COMPAT_CACHE: "0" };
    writeCompatibilityNoticesCache({
      config: CONFIG_A,
      env: disabledEnv,
      workspaceDir,
      notices: SAMPLE_NOTICES,
    });
    const filePath = resolveCompatibilityNoticesCachePath({ workspaceDir, env: disabledEnv });
    expect(syncFs.existsSync(filePath)).toBe(false);

    writeCompatibilityNoticesCache({
      config: CONFIG_A,
      env: CACHE_ENV,
      workspaceDir,
      notices: SAMPLE_NOTICES,
    });
    expect(
      readCompatibilityNoticesCache({ config: CONFIG_A, env: disabledEnv, workspaceDir }),
    ).toBeNull();
  });
});
