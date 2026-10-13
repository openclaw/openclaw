// Verifies bundled plugin directory resolution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function createOpenClawRoot(params: {
  prefix: string;
  hasExtensions?: boolean;
  hasSrc?: boolean;
  hasDistRuntimeExtensions?: boolean;
  hasDistExtensions?: boolean;
  hasGitCheckout?: boolean;
  hasPnpmWorkspace?: boolean;
}) {
  const repoRoot = makeRepoRoot(params.prefix);
  if (params.hasExtensions) {
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
  }
  if (params.hasSrc) {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  }
  if (params.hasDistRuntimeExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
  }
  if (params.hasDistExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
  }
  if (params.hasGitCheckout) {
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
  }
  if (params.hasPnpmWorkspace) {
    fs.writeFileSync(
      path.join(repoRoot, "pnpm-workspace.yaml"),
      "packages:\n  - .\n  - extensions/*\n",
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
    "utf8",
  );
  return repoRoot;
}

function seedBundledPluginTree(rootDir: string, relativeDir: string, pluginId = "discord") {
  const pluginDir = path.join(rootDir, relativeDir, pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: `@openclaw/${pluginId}` }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({ id: pluginId }, null, 2)}\n`,
    "utf8",
  );
}

function expectResolvedBundledDirFromRoot(params: {
  repoRoot: string;
  expectedRelativeDir: string;
  vitest?: string;
  execArgv?: readonly string[];
}) {
  vi.spyOn(process, "cwd").mockReturnValue(params.repoRoot);
  process.argv[1] = path.join(params.repoRoot, "openclaw.mjs");
  process.execArgv.length = 0;
  process.execArgv.push(...(params.execArgv ?? []));
  if (params.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = params.vitest;
  }
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
    fs.realpathSync(path.join(params.repoRoot, params.expectedRelativeDir)),
  );
}

function requireBundledDir(value: string | null | undefined): string {
  if (!value) {
    throw new Error("expected bundled plugins dir");
  }
  return value;
}

beforeEach(() => {
  delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  originalEnv.restore();
  if (originalArgv1 === undefined) {
    process.argv.splice(1, 1);
  } else {
    process.argv[1] = originalArgv1;
  }
  process.execArgv.length = 0;
  process.execArgv.push(...originalExecArgv);
  cleanupTrackedTempDirs(tempDirs);
});

describe("resolveBundledPluginsDir", () => {
  const sourceCheckout = { hasExtensions: true, hasSrc: true, hasPnpmWorkspace: true };
  const builtTrees = { hasDistExtensions: true, hasDistRuntimeExtensions: true };
  it.each<{
    name: string;
    layout: Omit<Parameters<typeof createOpenClawRoot>[0], "prefix">;
    expected: string;
    vitest?: string;
    execArgv?: string[];
    incompleteBuilt?: boolean;
    inspectBuilt?: boolean;
  }>([
    { name: "runtime bundle", layout: builtTrees, expected: "dist-runtime/extensions" },
    {
      name: "installed dist fallback",
      layout: { hasDistExtensions: true },
      expected: "dist/extensions",
    },
    {
      name: "source host",
      layout: { ...sourceCheckout, ...builtTrees, hasGitCheckout: true },
      expected: "extensions",
      inspectBuilt: true,
    },
    {
      name: "VITEST alone",
      layout: { ...builtTrees, hasExtensions: true },
      expected: "dist-runtime/extensions",
      vitest: "true",
    },
    {
      name: "tsx source host",
      layout: { ...sourceCheckout, ...builtTrees, hasGitCheckout: true },
      expected: "extensions",
      execArgv: ["--import", "tsx"],
      inspectBuilt: true,
    },
    {
      name: "unbuilt checkout",
      layout: { ...sourceCheckout, hasGitCheckout: true },
      expected: "extensions",
    },
    {
      name: "incomplete builds",
      layout: { ...sourceCheckout, ...builtTrees, hasGitCheckout: true },
      expected: "extensions",
      incompleteBuilt: true,
    },
    { name: "workspace mirror without git", layout: sourceCheckout, expected: "extensions" },
    {
      name: "git without workspace metadata",
      layout: { ...builtTrees, hasExtensions: true, hasSrc: true, hasGitCheckout: true },
      expected: "dist-runtime/extensions",
    },
  ])("resolves $name", ({ layout, expected, vitest, execArgv, incompleteBuilt, inspectBuilt }) => {
    const repoRoot = createOpenClawRoot({ prefix: "openclaw-bundled-layout-", ...layout });
    for (const [present, relative] of [
      [layout.hasExtensions, "extensions"],
      [layout.hasDistExtensions, "dist/extensions"],
      [layout.hasDistRuntimeExtensions, "dist-runtime/extensions"],
    ] as const) {
      if (!present) {
        continue;
      }
      if (incompleteBuilt && relative !== "extensions") {
        fs.mkdirSync(path.join(repoRoot, relative, "discord"), { recursive: true });
      } else {
        seedBundledPluginTree(repoRoot, relative);
      }
    }
    if (inspectBuilt) {
      expect(resolveBundledDirFromPackageRoot(repoRoot)).toBe(
        path.join(repoRoot, "dist/extensions"),
      );
    }
    expectResolvedBundledDirFromRoot({ repoRoot, expectedRelativeDir: expected, vitest, execArgv });
  });

  it("reports missing pnpm workspace deps for source checkouts", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-source-deps-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(repoRoot, "extensions", "twitch");
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = path.join(repoRoot, "openclaw.mjs");

    expect(resolveSourceCheckoutDependencyDiagnostic()).toEqual({
      source: repoRoot,
      message:
        "OpenClaw source checkout detected without pnpm workspace dependencies; run `pnpm install` from the repo root so bundled plugins can load package-local dependencies.",
    });

    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    expect(resolveSourceCheckoutDependencyDiagnostic()).toBeNull();

    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    fs.mkdirSync(path.join(repoRoot, "node_modules", ".pnpm"), { recursive: true });
    // The diagnostic also scans the real checkout hosting this test run (via
    // module-root resolution), which may itself lack node_modules in nested
    // worktrees; only assert the satisfied fixture is no longer reported.
    expect(
      withPluginCache(createPluginCache(), () => resolveSourceCheckoutDependencyDiagnostic())
        ?.source,
    ).not.toBe(repoRoot);
  });

  it("returns a stable empty bundled plugin directory when bundled plugins are disabled", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-disabled-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
    process.argv[1] = "/usr/bin/env";
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.existsSync(bundledDir)).toBe(true);
    expect(fs.readdirSync(bundledDir)).toStrictEqual([]);
  });

  it("reuses the prepared bundled root until its cache owner changes", () => {
    const repoRoot = fs.realpathSync(
      createOpenClawRoot({
        prefix: "openclaw-bundled-dir-owner-",
        hasExtensions: true,
        hasSrc: true,
        hasPnpmWorkspace: true,
      }),
    );
    seedBundledPluginTree(repoRoot, "extensions");
    const owner = createPluginCache();
    withPluginCache(owner, () =>
      expectResolvedBundledDirFromRoot({ repoRoot, expectedRelativeDir: "extensions" }),
    );

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
          expect(fs.realpathSync(resolveBundledPluginsDir(env) ?? "")).toBe(
            fs.realpathSync(path.join(home, "bundled")),
          );
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

      vi.spyOn(process, "cwd").mockReturnValue(overrideRoot);
      process.argv[1] = "/usr/bin/env";
      process.execArgv.length = 0;
      for (const key of ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV"]) {
        vi.stubEnv(key, undefined);
      }
      const env: NodeJS.ProcessEnv = separateEnv ? {} : process.env;
      const trustEnv = trustSource === "explicit" ? env : process.env;
      const runtimeEnv = runtimeSource === "explicit" ? env : process.env;
      runtimeEnv.VITEST = "true";
      env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

      const expectedOverride = fs.realpathSync(path.join(overrideRoot, "extensions"));
      withPluginCache(createPluginCache(), () => {
        for (const trust of [false, true, false]) {
          if (trust) {
            trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
          } else {
            delete trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
          }
          const bundledDir = fs.realpathSync(requireBundledDir(resolveBundledPluginsDir(env)));
          if (trust) {
            expect(bundledDir).toBe(expectedOverride);
          } else {
            expect(bundledDir).not.toBe(expectedOverride);
          }
        }
        trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
        for (const vitest of ["true", undefined, "true"]) {
          if (vitest) {
            runtimeEnv.VITEST = vitest;
          } else {
            delete runtimeEnv.VITEST;
          }
          const bundledDir = fs.realpathSync(requireBundledDir(resolveBundledPluginsDir(env)));
          expect(bundledDir === expectedOverride).toBe(vitest !== undefined);
        }
      });
    },
  );

  it.each(["vitest", "untrusted cwd", "enclosing tooling checkout"] as const)(
    "ignores the %s package root",
    (mode) => {
      const repoRoot = createOpenClawRoot({
        prefix: "openclaw-bundled-untrusted-",
        hasExtensions: true,
        hasSrc: true,
        hasGitCheckout: true,
        hasDistExtensions: mode === "enclosing tooling checkout",
        hasPnpmWorkspace: mode === "enclosing tooling checkout",
      });
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
      const bundledDir = fs.realpathSync(requireBundledDir(resolveBundledPluginsDir()));
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
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-installed-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, "dist/extensions");
    const installedDir = path.join(installedRoot, "dist/extensions");
    const cwd =
      mode === "argv override"
        ? installedRoot
        : createOpenClawRoot({
            prefix: "openclaw-bundled-cwd-",
            hasExtensions: true,
            hasSrc: true,
            hasGitCheckout: true,
          });
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
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    process.argv[1] =
      mode === "missing override" ? "/usr/bin/env" : path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    if (override) {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = override;
    } else {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    }
    const bundledDir = requireBundledDir(resolveBundledPluginsDir());
    if (mode === "missing override") {
      expect(path.resolve(bundledDir)).not.toBe(path.resolve(override!));
    } else if (mode === "argv override") {
      expect(fs.realpathSync(bundledDir)).not.toBe(fs.realpathSync(installedDir));
    } else {
      expect(fs.realpathSync(bundledDir)).toBe(fs.realpathSync(installedDir));
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
    const current = createOpenClawRoot({ prefix: "foreign-current-", hasDistExtensions: true });
    const previous = createOpenClawRoot({ prefix: "foreign-previous-", hasDistExtensions: true });
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
      fs.writeFileSync(
        path.join(previous, "package.json"),
        JSON.stringify({ name: "external-package" }),
      );
    }
    let pluginRoot = path.join(mode === "own" ? current : previous, relativeDir, "probe");
    if (mode === "symlink") {
      const alias = path.join(makeRepoRoot("foreign-alias-"), "probe");
      fs.symlinkSync(pluginRoot, alias, "dir");
      pluginRoot = alias;
    }
    const resolveRoot = openClawRoot.resolveOpenClawPackageRootSync;
    const spy = vi
      .spyOn(openClawRoot, "resolveOpenClawPackageRootSync")
      .mockImplementation((options) =>
        options.cwd ? resolveRoot(options) : mode === "unknown" ? null : current,
      );
    try {
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
    } finally {
      spy.mockRestore();
    }
  });
});

describe("relocated compiled bundle precedence", () => {
  const makeTempDir = () => makeRepoRoot("bundled-precedence-");
  const mkdirSafe = (root: string) => fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const writeManifest = (root: string, manifest: object) =>
    fs.writeFileSync(path.join(root, "openclaw.plugin.json"), JSON.stringify(manifest));
  function createPluginCandidate({
    installOwner,
    ...candidate
  }: Pick<PluginCandidate, "idHint" | "rootDir" | "origin"> & {
    installOwner?: string;
  }): PluginCandidate {
    return recordPluginCandidateInstallOwner(
      { ...candidate, source: path.join(candidate.rootDir, "index.ts") },
      installOwner,
    );
  }

  it.each(["config", "configSelected", "source-link", "external", "lookalike", "dev-source"])(
    "preserves the intentional %s override without trust elevation",
    (mode) => {
      const root = makeTempDir();
      const current = path.join(root, "current");
      const previous = path.join(root, "previous");
      const currentPlugin = path.join(current, "dist/extensions/probe");
      const selectedPlugin = path.join(
        previous,
        mode === "source-link"
          ? "extensions/probe"
          : mode === "external"
            ? "plugins/probe"
            : "dist/extensions/probe",
      );
      for (const pluginRoot of [currentPlugin, selectedPlugin]) {
        mkdirSafe(pluginRoot);
        writeManifest(pluginRoot, { id: "probe", configSchema: { type: "object" } });
      }
      for (const packageRoot of [current, previous]) {
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name:
              packageRoot === previous && mode === "lookalike" ? "ordinary-external" : "openclaw",
          }),
        );
      }
      if (mode === "dev-source") {
        fs.writeFileSync(path.join(previous, "pnpm-workspace.yaml"), "packages: [extensions/*]\n");
        mkdirSafe(path.join(previous, "src"));
        mkdirSafe(path.join(previous, "extensions"));
      }
      const selected = createPluginCandidate({
        idHint: "probe",
        rootDir: selectedPlugin,
        origin: mode === "config" ? "config" : "global",
        installOwner: "probe",
      });
      if (mode === "configSelected") {
        selected.configSelected = true;
      }
      const argv = process.argv;
      process.argv = [...argv];
      process.argv[1] = path.join(current, "openclaw.mjs");
      try {
        const registry = withPluginCache(createPluginCache(), () =>
          loadPluginManifestRegistryCore({
            env: mode === "dev-source" ? { OPENCLAW_DEV_SOURCE_ROOT: previous } : {},
            installRecords: { probe: { source: "path", installPath: selectedPlugin } },
            candidates: [
              createPluginCandidate({ idHint: "probe", rootDir: currentPlugin, origin: "bundled" }),
              selected,
            ],
          }),
        );
        expect(registry.plugins[0]).toMatchObject({
          rootDir: selectedPlugin,
          trust: { reason: "origin-path" },
        });
        expect(
          registry.diagnostics.some((d) => d.message.includes("stale plugin install record")),
        ).toBe(false);
      } finally {
        process.argv = argv;
      }
    },
  );

  it.each([false, true])(
    "retains the current bundle and diagnoses the old record (reversed=%s)",
    (reversed) => {
      const root = makeTempDir();
      const makeInstall = (name: string) => {
        const packageRoot = path.join(root, name);
        const pluginDir = path.join(packageRoot, "dist", "extensions", "relocation-probe");
        mkdirSafe(pluginDir);
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        writeManifest(pluginDir, { id: "relocation-probe", configSchema: { type: "object" } });
        return { packageRoot, pluginDir };
      };
      const current = makeInstall("current");
      const previous = makeInstall("previous");
      const oldManifest = fs.readFileSync(path.join(previous.pluginDir, "openclaw.plugin.json"));
      const installRecords = {
        "relocation-probe": { source: "path" as const, installPath: previous.pluginDir },
      };
      const recordsBefore = JSON.stringify(installRecords);
      const config = {
        plugins: {
          entries: { "relocation-probe": { enabled: true, config: { marker: "preserve" } } },
          allow: ["relocation-probe"],
          slots: { memory: "relocation-probe", contextEngine: "relocation-probe" },
        },
        channels: { "relocation-probe": { enabled: true, account: "synthetic" } },
      };
      const configBefore = JSON.stringify(config);
      const staleCandidate = createPluginCandidate({
        idHint: "relocation-probe",
        rootDir: previous.pluginDir,
        origin: "global",
        installOwner: "relocation-probe",
      });
      const candidates = [
        staleCandidate,
        createPluginCandidate({
          idHint: "relocation-probe",
          rootDir: current.pluginDir,
          origin: "bundled",
        }),
      ];
      const argv = process.argv;
      process.argv = [...argv];
      process.argv[1] = path.join(current.packageRoot, "openclaw.mjs");
      try {
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
      } finally {
        process.argv = argv;
      }
    },
  );
});
