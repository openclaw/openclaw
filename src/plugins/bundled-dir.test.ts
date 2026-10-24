import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as openClawRoot from "../infra/openclaw-root.js";
import { captureEnv } from "../test-utils/env.js";
import {
  isForeignBundledPluginRoot,
  resolveBundledDirFromPackageRoot,
  resolveBundledPluginsDir,
  resolveSourceCheckoutDependencyDiagnostic,
} from "./bundled-dir.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { writeJson } from "./generated-plugin-test-helpers.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const originalEnv = captureEnv([
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "VITEST",
]);
const originalArgv1 = process.argv[1];
const originalExecArgv = [...process.execArgv];

function makeRepoRoot(prefix: string): string {
  return makeTrackedTempDir(prefix, tempDirs);
}

const sourceDirs = ["extensions", "src"];
const builtDirs = ["dist/extensions", "dist-runtime/extensions"];
const allDirs = [...sourceDirs, ...builtDirs];
function createOpenClawRoot(
  dirs: readonly string[],
  { prefix = "openclaw-bundled-", git = false, workspace = false } = {},
) {
  const repoRoot = makeRepoRoot(prefix);
  for (const dir of dirs) {
    fs.mkdirSync(path.join(repoRoot, dir), { recursive: true });
  }
  if (git) {
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
  }
  if (workspace) {
    fs.writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages: [., extensions/*]\n");
  }
  writeJson(path.join(repoRoot, "package.json"), { name: "openclaw" });
  return repoRoot;
}

function seedBundledPluginTree(rootDir: string, relativeDir: string, pluginId = "discord") {
  const pluginDir = path.join(rootDir, relativeDir, pluginId);
  writeJson(path.join(pluginDir, "package.json"), { name: `@openclaw/${pluginId}` });
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), { id: pluginId });
}

function setRuntime(cwd: string, argv1 = path.join(cwd, "openclaw.mjs")) {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.argv[1] = argv1;
  process.execArgv.length = 0;
  delete process.env.VITEST;
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
}

function expectResolvedBundledDirFromRoot(repoRoot: string, relativeDir: string) {
  setRuntime(repoRoot);
  expect(realBundledDir()).toBe(fs.realpathSync(path.join(repoRoot, relativeDir)));
}

function realBundledDir(env?: NodeJS.ProcessEnv) {
  const dir = resolveBundledPluginsDir(env);
  assert(dir, "expected bundled plugins dir");
  return fs.realpathSync(dir);
}

beforeEach(() => {
  delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  originalEnv.restore();
  process.argv.splice(1, 1, ...(originalArgv1 === undefined ? [] : [originalArgv1]));
  process.execArgv.length = 0;
  process.execArgv.push(...originalExecArgv);
  cleanupTrackedTempDirs(tempDirs);
});

describe("resolveBundledPluginsDir", () => {
  it.each([
    ["runtime bundle", builtDirs, "dist-runtime/extensions", false, false],
    ["installed dist fallback", ["dist/extensions"], "dist/extensions", false, false],
    ["source host", allDirs, "extensions", true, true],
    ["workspace mirror without git", sourceDirs, "extensions", true, false],
    ["git without workspace metadata", allDirs, "dist-runtime/extensions", false, true],
  ] as const)("resolves %s", (_name, dirs, expected, workspace, git) => {
    const repoRoot = createOpenClawRoot(dirs, { workspace, git });
    for (const dir of dirs.filter((entry) => entry.endsWith("extensions"))) {
      seedBundledPluginTree(repoRoot, dir);
    }
    if (workspace && git) {
      expect(resolveBundledDirFromPackageRoot(repoRoot)).toBe(
        path.join(repoRoot, "dist/extensions"),
      );
    }
    expectResolvedBundledDirFromRoot(repoRoot, expected);
  });

  it("reports missing pnpm workspace deps for source checkouts", () => {
    const repoRoot = createOpenClawRoot(sourceDirs, { git: true, workspace: true });
    seedBundledPluginTree(repoRoot, "extensions", "twitch");
    setRuntime(repoRoot);

    expect(resolveSourceCheckoutDependencyDiagnostic()).toEqual({
      source: repoRoot,
      message:
        "OpenClaw source checkout detected without pnpm workspace dependencies; run `pnpm install` from the repo root so bundled plugins can load package-local dependencies.",
    });

    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    expect(resolveSourceCheckoutDependencyDiagnostic()).toBeNull();

    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".pnpm"), { recursive: true });
    // Module-root resolution may still diagnose the real checkout hosting this test.
    expect(
      withPluginCache(createPluginCache(), () => resolveSourceCheckoutDependencyDiagnostic())
        ?.source,
    ).not.toBe(repoRoot);
  });

  it("returns a stable empty bundled plugin directory when bundled plugins are disabled", () => {
    const repoRoot = createOpenClawRoot(sourceDirs, {
      prefix: "openclaw-bundled-dir-disabled-",
      git: true,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = "/usr/bin/env";
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const bundledDir = realBundledDir();

    expect(fs.existsSync(bundledDir)).toBe(true);
    expect(fs.readdirSync(bundledDir)).toStrictEqual([]);
  });

  it("reuses the prepared bundled root until its cache owner changes", () => {
    const repoRoot = fs.realpathSync(createOpenClawRoot(sourceDirs, { workspace: true }));
    seedBundledPluginTree(repoRoot, "extensions");
    const owner = createPluginCache();
    withPluginCache(owner, () => expectResolvedBundledDirFromRoot(repoRoot, "extensions"));

    const resolveRoot = vi.spyOn(openClawRoot, "resolveOpenClawPackageRootSync");
    let runtimeEnvReads = 0;
    const env: NodeJS.ProcessEnv = {
      get VITEST() {
        runtimeEnvReads++;
        return undefined;
      },
    };
    const sourceDir = path.join(repoRoot, "extensions");
    expect(withPluginCache(owner, () => resolveBundledPluginsDir(env))).toBe(sourceDir);
    expect(runtimeEnvReads).toBe(0);
    seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    expect(withPluginCache(owner, resolveBundledPluginsDir)).toBe(sourceDir);
    expect(resolveRoot).not.toHaveBeenCalled();

    expect(withPluginCache(createPluginCache(), resolveBundledPluginsDir)).toBe(sourceDir);
    expect(resolveRoot).toHaveBeenCalled();
    expect(withPluginCache(owner, resolveBundledPluginsDir)).toBe(sourceDir);
  });

  it.each(["OPENCLAW_HOME", "HOME", "USERPROFILE", "cwd"] as const)(
    "separates relative override resolution by %s within one cache owner",
    (homeSource) => {
      const homeA = makeRepoRoot("openclaw-bundled-dir-home-a-");
      const homeB = makeRepoRoot("openclaw-bundled-dir-home-b-");
      seedBundledPluginTree(homeA, "bundled", "memory-core");
      seedBundledPluginTree(homeB, "bundled", "discord");
      const envBase = {
        OPENCLAW_BUNDLED_PLUGINS_DIR: homeSource === "cwd" ? "./bundled" : "~/bundled",
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        VITEST: "true",
      } satisfies NodeJS.ProcessEnv;

      const cwd = vi.spyOn(process, "cwd");
      withPluginCache(createPluginCache(), () => {
        for (const home of [homeA, homeB, homeA]) {
          if (homeSource === "cwd") {
            cwd.mockReturnValue(home);
          }
          const env = homeSource === "cwd" ? envBase : { ...envBase, [homeSource]: home };
          expect(realBundledDir(env)).toBe(fs.realpathSync(path.join(home, "bundled")));
        }
      });
    },
  );

  it.each([
    { separateEnv: false, trustSource: "ambient", runtimeSource: "ambient" },
    { separateEnv: true, trustSource: "explicit", runtimeSource: "explicit" },
    { separateEnv: true, trustSource: "explicit", runtimeSource: "ambient" },
    { separateEnv: true, trustSource: "ambient", runtimeSource: "explicit" },
    { separateEnv: true, trustSource: "ambient", runtimeSource: "ambient" },
  ])(
    "rechecks $trustSource trust with $runtimeSource runtime (separate env: $separateEnv)",
    ({ separateEnv, trustSource, runtimeSource }) => {
      const overrideRoot = makeRepoRoot("openclaw-bundled-dir-vitest-override-reject-");
      seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

      setRuntime(overrideRoot, "/usr/bin/env");
      for (const key of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV"]) {
        vi.stubEnv(key, undefined);
      }
      const env: NodeJS.ProcessEnv = separateEnv ? {} : process.env;
      const trustEnv = trustSource === "explicit" ? env : process.env;
      const runtimeEnv = runtimeSource === "explicit" ? env : process.env;
      runtimeEnv.VITEST = "true";
      env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");

      const expectedOverride = fs.realpathSync(path.join(overrideRoot, "extensions"));
      withPluginCache(createPluginCache(), () => {
        for (const trust of [false, true, false]) {
          if (trust) {
            trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
          } else {
            delete trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
          }
          expect(realBundledDir(env) === expectedOverride).toBe(trust);
        }
        trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
        for (const vitest of ["true", undefined, "true"]) {
          if (vitest) {
            runtimeEnv.VITEST = vitest;
          } else {
            delete runtimeEnv.VITEST;
          }
          expect(realBundledDir(env) === expectedOverride).toBe(vitest !== undefined);
        }
      });
    },
  );

  it.each(["vitest", "untrusted cwd", "enclosing tooling checkout"] as const)(
    "ignores the %s package root",
    (mode) => {
      const repoRoot = createOpenClawRoot(
        [...sourceDirs, ...(mode === "enclosing tooling checkout" ? ["dist/extensions"] : [])],
        { git: true, workspace: mode === "enclosing tooling checkout" },
      );
      const sourceDir = path.join(repoRoot, "extensions");
      if (mode === "untrusted cwd") {
        const pluginDir = path.join(sourceDir, "memory-core");
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(
          path.join(pluginDir, "runtime-api.js"),
          "export const marker = 'untrusted-cwd';\n",
        );
      } else {
        seedBundledPluginTree(repoRoot, "extensions", "memory-core");
      }
      let cwd = repoRoot;
      let argv1 = "/usr/bin/env";
      if (mode === "enclosing tooling checkout") {
        seedBundledPluginTree(repoRoot, "dist/extensions");
        argv1 = path.join(repoRoot, "node_modules/vitest/dist/workers/threads.js");
        fs.mkdirSync(path.dirname(argv1), { recursive: true });
        fs.writeFileSync(argv1, "");
        cwd = path.join(repoRoot, ".worktrees/pr-1234");
        fs.mkdirSync(cwd, { recursive: true });
      }
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      process.argv[1] = argv1;
      process.execArgv.length = 0;
      if (mode === "vitest") {
        process.env.VITEST = "true";
      } else if (mode === "untrusted cwd") {
        delete process.env.VITEST;
      }
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      const bundledDir = realBundledDir();
      expect(bundledDir).not.toBe(fs.realpathSync(sourceDir));
      if (mode === "enclosing tooling checkout") {
        expect(bundledDir).not.toBe(fs.realpathSync(path.join(repoRoot, "dist/extensions")));
      }
    },
  );

  it.each([
    "argv override",
    "missing override",
    "unrelated override",
    "unrelated cwd",
    "stale override",
  ] as const)("resolves the installed package without trusting an %s", (mode) => {
    const installedRoot = createOpenClawRoot(["dist/extensions"]);
    seedBundledPluginTree(installedRoot, "dist/extensions");
    const installedDir = path.join(installedRoot, "dist/extensions");
    const cwd =
      mode === "argv override" ? installedRoot : createOpenClawRoot(sourceDirs, { git: true });
    let override: string | undefined;
    if (mode === "argv override") {
      override = installedDir;
    } else if (mode === "unrelated override") {
      const root = makeRepoRoot("openclaw-bundled-override-");
      seedBundledPluginTree(root, "extensions", "memory-core");
      override = path.join(root, "extensions");
    } else if (mode !== "unrelated cwd") {
      override = path.join(installedRoot, "missing-extensions");
    }
    setRuntime(
      cwd,
      mode === "missing override" ? "/usr/bin/env" : path.join(installedRoot, "openclaw.mjs"),
    );
    if (override) {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = override;
    }
    const bundledDir = realBundledDir();
    if (mode === "missing override") {
      expect(path.resolve(bundledDir)).not.toBe(path.resolve(override!));
    } else if (mode === "argv override") {
      expect(bundledDir).not.toBe(fs.realpathSync(installedDir));
    } else {
      expect(bundledDir).toBe(fs.realpathSync(installedDir));
    }
  });
});

describe("foreign compiled bundle recognition", () => {
  it.each([
    { mode: "foreign", expected: true },
    { mode: "dist-runtime", expected: true },
    { mode: "own", expected: false },
    { mode: "unknown", expected: false },
    { mode: "override", expected: false },
    { mode: "source-link", expected: false },
    { mode: "external", expected: false },
    { mode: "lookalike", expected: false },
    { mode: "symlink", expected: true },
  ])("preserves the $mode ownership boundary", ({ mode, expected }) => {
    const current = createOpenClawRoot(["dist/extensions"], { prefix: "foreign-current-" });
    const previous = createOpenClawRoot(["dist/extensions"], { prefix: "foreign-previous-" });
    seedBundledPluginTree(current, "dist/extensions", "probe");
    const relativeDir =
      mode === "dist-runtime"
        ? "dist-runtime/extensions"
        : mode === "source-link"
          ? "extensions"
          : mode === "external"
            ? "plugins"
            : "dist/extensions";
    seedBundledPluginTree(previous, relativeDir, "probe");
    if (mode === "lookalike") {
      writeJson(path.join(previous, "package.json"), { name: "external-package" });
    }
    let pluginRoot = path.join(mode === "own" ? current : previous, relativeDir, "probe");
    if (mode === "symlink") {
      const alias = path.join(makeRepoRoot("foreign-alias-"), "probe");
      fs.symlinkSync(pluginRoot, alias, "dir");
      pluginRoot = alias;
    }
    const resolveRoot = openClawRoot.resolveOpenClawPackageRootSync;
    vi.spyOn(openClawRoot, "resolveOpenClawPackageRootSync").mockImplementation((options) =>
      options.cwd ? resolveRoot(options) : mode === "unknown" ? null : current,
    );
    const env =
      mode === "override"
        ? {
            VITEST: "true",
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
            OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(previous, relativeDir),
          }
        : {};
    expect(
      withPluginCache(createPluginCache(), () => isForeignBundledPluginRoot(pluginRoot, env)),
    ).toBe(expected);
  });
});

describe("relocated compiled bundle precedence", () => {
  function createInstall(
    packageRoot: string,
    id = "probe",
    tree = "dist/extensions",
    name = "openclaw",
  ) {
    const pluginDir = path.join(packageRoot, tree, id);
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o755 });
    writeJson(path.join(packageRoot, "package.json"), { name });
    writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
      id,
      configSchema: { type: "object" },
    });
    return { packageRoot, pluginDir };
  }
  function candidate(
    rootDir: string,
    origin: PluginCandidate["origin"],
    idHint = "probe",
    installOwner?: string,
  ): PluginCandidate {
    return recordPluginCandidateInstallOwner(
      { rootDir, origin, idHint, source: path.join(rootDir, "index.ts") },
      installOwner,
    );
  }

  it.each(["config", "configSelected", "source-link", "external", "lookalike", "dev-source"])(
    "preserves the intentional %s override without trust elevation",
    (mode) => {
      const root = makeRepoRoot("bundled-precedence-");
      const current = path.join(root, "current");
      const previous = path.join(root, "previous");
      const { pluginDir: currentPlugin } = createInstall(current);
      const { pluginDir: selectedPlugin } = createInstall(
        previous,
        "probe",
        mode === "source-link" ? "extensions" : mode === "external" ? "plugins" : "dist/extensions",
        mode === "lookalike" ? "ordinary-external" : "openclaw",
      );
      if (mode === "dev-source") {
        fs.writeFileSync(path.join(previous, "pnpm-workspace.yaml"), "packages: [extensions/*]\n");
        fs.mkdirSync(path.join(previous, "src"), { recursive: true, mode: 0o755 });
        fs.mkdirSync(path.join(previous, "extensions"), { recursive: true, mode: 0o755 });
      }
      const selected = candidate(
        selectedPlugin,
        mode === "config" ? "config" : "global",
        "probe",
        "probe",
      );
      if (mode === "configSelected") {
        selected.configSelected = true;
      }
      process.argv[1] = path.join(current, "openclaw.mjs");
      const registry = withPluginCache(createPluginCache(), () =>
        loadPluginManifestRegistryCore({
          env: mode === "dev-source" ? { OPENCLAW_DEV_SOURCE_ROOT: previous } : {},
          installRecords: { probe: { source: "path", installPath: selectedPlugin } },
          candidates: [candidate(currentPlugin, "bundled"), selected],
        }),
      );
      expect(registry.plugins[0]).toMatchObject({
        rootDir: selectedPlugin,
        trust: { reason: "origin-path" },
      });
      expect(
        registry.diagnostics.some((d) => d.message.includes("stale plugin install record")),
      ).toBe(false);
    },
  );

  it.each([false, true])(
    "retains the current bundle and diagnoses the old record (reversed=%s)",
    (reversed) => {
      const id = "relocation-probe";
      const root = makeRepoRoot("bundled-precedence-");
      const current = createInstall(path.join(root, "current"), id);
      const previous = createInstall(path.join(root, "previous"), id);
      const oldManifest = fs.readFileSync(path.join(previous.pluginDir, "openclaw.plugin.json"));
      const installRecords = {
        [id]: { source: "path" as const, installPath: previous.pluginDir },
      };
      const recordsBefore = JSON.stringify(installRecords);
      const config = {
        plugins: {
          entries: { [id]: { enabled: true, config: { marker: "preserve" } } },
          allow: [id],
          slots: { memory: id, contextEngine: id },
        },
        channels: { [id]: { enabled: true, account: "synthetic" } },
      };
      const configBefore = JSON.stringify(config);
      const staleCandidate = candidate(previous.pluginDir, "global", id, id);
      const candidates = [staleCandidate, candidate(current.pluginDir, "bundled", id)];
      process.argv[1] = path.join(current.packageRoot, "openclaw.mjs");
      const registry = withPluginCache(createPluginCache(), () =>
        loadPluginManifestRegistryCore({
          env: {},
          config,
          installRecords,
          candidates: reversed ? candidates.toReversed() : candidates,
        }),
      );
      expect(registry.plugins[0]).toMatchObject({
        rootDir: current.pluginDir,
        origin: "bundled",
        trust: { reason: "bundled" },
      });
      const warning = registry.diagnostics.find((d) =>
        d.message.includes("stale plugin install record"),
      );
      expect(warning).toMatchObject({ level: "warn", source: staleCandidate.source });
      expect(warning?.message).toContain(previous.pluginDir);
      expect(warning?.message).toContain("No uninstall is needed");
      expect(warning?.message).toContain("removes plugin configuration");
      expect(warning?.message).toContain("re-enabling does not restore it");
      expect(JSON.stringify(installRecords)).toBe(recordsBefore);
      expect(JSON.stringify(config)).toBe(configBefore);
      expect(fs.readFileSync(path.join(previous.pluginDir, "openclaw.plugin.json"))).toEqual(
        oldManifest,
      );
    },
  );
});
