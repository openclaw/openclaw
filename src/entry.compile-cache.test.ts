import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../test/helpers/temp-dir.js";
import {
  OPENCLAW_COMPILE_CACHE_DIR_ENV,
  buildOpenClawCompileCacheRespawnPlan,
  enableOpenClawCompileCache,
  isSourceCheckoutInstallRoot,
  prepareOpenClawCompileCacheDirectory,
  resolveEntryInstallRoot,
  resolveOpenClawCompileCacheDirectory,
  shouldEnableOpenClawCompileCache,
} from "./entry.compile-cache.js";

describe("entry compile cache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });

  it("resolves install roots from source and dist entry paths", () => {
    expect(resolveEntryInstallRoot("/repo/openclaw/src/entry.ts")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/repo/openclaw/dist/entry.js")).toBe("/repo/openclaw");
    expect(resolveEntryInstallRoot("/pkg/openclaw/entry.js")).toBe("/pkg/openclaw");
  });

  it("treats git and source entry markers as source checkouts", async () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-source-");
    await fs.writeFile(path.join(root, ".git"), "gitdir: .git/worktrees/openclaw\n", "utf8");

    expect(isSourceCheckoutInstallRoot(root)).toBe(true);
  });

  it("disables compile cache for source-checkout installs", async () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-src-entry-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "entry.ts"), "export {};\n", "utf8");

    expect(
      shouldEnableOpenClawCompileCache({
        env: {},
        installRoot: root,
      }),
    ).toBe(false);
  });

  it("keeps compile cache enabled for packaged installs unless disabled by env", () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-package-");

    expect(shouldEnableOpenClawCompileCache({ env: {}, installRoot: root })).toBe(true);
    expect(
      shouldEnableOpenClawCompileCache({
        env: { NODE_DISABLE_COMPILE_CACHE: "1" },
        installRoot: root,
      }),
    ).toBe(false);
  });

  it("uses a version-scoped default cache directory for packaged installs", () => {
    const directory = resolveOpenClawCompileCacheDirectory({
      env: {},
      installRoot: "/opt/openclaw",
      version: "2026.4.5",
      tmpdir: () => "/tmp/openclaw-tests",
    });

    expect(path.basename(directory)).toBe("2026.4.5");
    expect(path.basename(path.dirname(directory))).toHaveLength(12);
    expect(path.dirname(path.dirname(directory))).toBe(
      path.join("/tmp/openclaw-tests", "node-compile-cache", "openclaw"),
    );
  });

  it("treats NODE_COMPILE_CACHE as a scoped base directory", () => {
    const directory = resolveOpenClawCompileCacheDirectory({
      env: { NODE_COMPILE_CACHE: "/var/tmp/openclaw-cache" },
      installRoot: "/opt/openclaw",
      version: "2026.4.5",
      tmpdir: () => "/tmp/ignored",
    });

    expect(path.basename(directory)).toBe("2026.4.5");
    expect(path.basename(path.dirname(directory))).toHaveLength(12);
    expect(path.dirname(path.dirname(directory))).toBe("/var/tmp/openclaw-cache");
  });

  it("reuses the prepared cache directory across repeated bootstrap calls", () => {
    const env: NodeJS.ProcessEnv = {};
    const initial = prepareOpenClawCompileCacheDirectory({
      env,
      installRoot: "/opt/openclaw",
      version: "2026.4.5",
      tmpdir: () => "/tmp/openclaw-tests",
    });

    env.NODE_COMPILE_CACHE = "/var/tmp/changed-base";

    const repeated = prepareOpenClawCompileCacheDirectory({
      env,
      installRoot: "/opt/other-openclaw",
      version: "2026.4.6",
      tmpdir: () => "/tmp/ignored",
    });

    expect(repeated).toBe(initial);
    expect(env[OPENCLAW_COMPILE_CACHE_DIR_ENV]).toBe(initial);
  });

  it("passes a string cacheDir into enableCompileCache", () => {
    const enableCompileCache = vi.fn();
    const env: NodeJS.ProcessEnv = {
      NODE_COMPILE_CACHE: "/var/tmp/openclaw-cache",
    };

    const directory = enableOpenClawCompileCache({
      enableCompileCache,
      env,
      installRoot: "/opt/openclaw",
      version: "2026.4.5",
      tmpdir: () => "/tmp/ignored",
    });

    expect(enableCompileCache).toHaveBeenCalledWith(directory);
    expect(env.NODE_COMPILE_CACHE).toBe("/var/tmp/openclaw-cache");
    expect(env[OPENCLAW_COMPILE_CACHE_DIR_ENV]).toBe(directory);
  });

  it("builds a one-shot no-cache respawn plan when source checkout inherits NODE_COMPILE_CACHE", async () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-respawn-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "entry.ts"), "export {};\n", "utf8");

    const plan = buildOpenClawCompileCacheRespawnPlan({
      currentFile: path.join(root, "dist", "entry.js"),
      env: { NODE_COMPILE_CACHE: "/tmp/openclaw-cache" },
      execArgv: ["--no-warnings"],
      execPath: "/usr/bin/node",
      installRoot: root,
      argv: ["/usr/bin/node", path.join(root, "dist", "entry.js"), "status", "--json"],
    });

    expect(plan).toEqual({
      command: "/usr/bin/node",
      args: ["--no-warnings", path.join(root, "dist", "entry.js"), "status", "--json"],
      env: {
        NODE_DISABLE_COMPILE_CACHE: "1",
        OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
      },
    });
  });

  it("does not respawn packaged installs when NODE_COMPILE_CACHE is configured", () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-package-respawn-");

    expect(
      buildOpenClawCompileCacheRespawnPlan({
        currentFile: path.join(root, "dist", "entry.js"),
        env: { NODE_COMPILE_CACHE: "/tmp/openclaw-cache" },
        installRoot: root,
      }),
    ).toBeUndefined();
  });

  it("does not respawn source checkouts twice", async () => {
    const root = makeTempDir(tempDirs, "openclaw-compile-cache-respawn-once-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "entry.ts"), "export {};\n", "utf8");

    expect(
      buildOpenClawCompileCacheRespawnPlan({
        currentFile: path.join(root, "dist", "entry.js"),
        env: {
          NODE_COMPILE_CACHE: "/tmp/openclaw-cache",
          OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
        },
        installRoot: root,
      }),
    ).toBeUndefined();
  });
});
