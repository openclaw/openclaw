// Verifies bundled plugin directory resolution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as openClawRoot from "../infra/openclaw-root.js";
import {
  isForeignBundledPluginRoot,
  resolveBundledPluginsDir,
  resolveSourceCheckoutDependencyDiagnostic,
} from "./bundled-dir.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalTrustBundledPlugins = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
const originalVitest = process.env.VITEST;
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

function expectResolvedBundledDir(params: {
  cwd: string;
  expectedDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  disableBundledPlugins?: string;
  vitest?: string;
  execArgv?: readonly string[];
}) {
  vi.spyOn(process, "cwd").mockReturnValue(params.cwd);
  process.argv[1] = params.argv1 ?? "/usr/bin/env";
  process.execArgv.length = 0;
  process.execArgv.push(...(params.execArgv ?? []));
  if (params.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = params.vitest;
  }
  if (params.bundledDirOverride === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = params.bundledDirOverride;
  }
  if (params.disableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = params.disableBundledPlugins;
  }

  expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
    fs.realpathSync(params.expectedDir),
  );
}

function expectResolvedBundledDirFromRoot(params: {
  repoRoot: string;
  expectedRelativeDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  vitest?: string;
  cwd?: string;
  execArgv?: readonly string[];
}) {
  expectResolvedBundledDir({
    cwd: params.cwd ?? params.repoRoot,
    expectedDir: path.join(params.repoRoot, params.expectedRelativeDir),
    argv1: params.argv1 ?? path.join(params.repoRoot, "openclaw.mjs"),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    ...(params.vitest !== undefined ? { vitest: params.vitest } : {}),
    ...(params.execArgv ? { execArgv: params.execArgv } : {}),
  });
}

function expectInstalledBundledDirScenario(params: {
  installedRoot: string;
  cwd?: string;
  argv1?: string;
  bundledDirOverride?: string;
}) {
  expectResolvedBundledDirFromRoot({
    repoRoot: params.installedRoot,
    cwd: params.cwd ?? process.cwd(),
    ...(params.argv1 ? { argv1: params.argv1 } : {}),
    ...(params.bundledDirOverride ? { bundledDirOverride: params.bundledDirOverride } : {}),
    expectedRelativeDir: path.join("dist", "extensions"),
  });
}

function expectInstalledBundledDirScenarioCase(
  createScenario: () => {
    installedRoot: string;
    cwd?: string;
    argv1?: string;
    bundledDirOverride?: string;
  },
) {
  expectInstalledBundledDirScenario(createScenario());
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
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalTrustBundledPlugins === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPlugins;
  }
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
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
  it.each([
    [
      "prefers the runtime bundled plugin tree from the package root",
      {
        prefix: "openclaw-bundled-dir-runtime-",
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
      },
    ],
    [
      "falls back to built dist/extensions in installed package roots",
      {
        prefix: "openclaw-bundled-dir-dist-",
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "prefers built dist/extensions in a pnpm git checkout outside vitest",
      {
        prefix: "openclaw-bundled-dir-git-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "does not prefer source extensions from VITEST alone",
      {
        prefix: "openclaw-bundled-dir-vitest-",
        hasExtensions: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
        vitest: "true",
      },
    ],
    [
      "prefers built dist/extensions during tsx-driven pnpm source execution",
      {
        prefix: "openclaw-bundled-dir-tsx-built-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
        execArgv: ["--import", "tsx"],
      },
    ],
    [
      "uses source extensions in a pnpm git checkout when built trees are missing",
      {
        prefix: "openclaw-bundled-dir-git-",
        hasExtensions: true,
        hasSrc: true,
        hasGitCheckout: true,
        hasPnpmWorkspace: true,
      },
      {
        expectedRelativeDir: "extensions",
      },
    ],
  ] as const)("%s", (_name, layout, expectation) => {
    const repoRoot = createOpenClawRoot(layout);
    if (expectation.expectedRelativeDir === path.join("dist-runtime", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
      seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));
    } else if (expectation.expectedRelativeDir === path.join("dist", "extensions")) {
      seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    } else if (expectation.expectedRelativeDir === "extensions") {
      seedBundledPluginTree(repoRoot, "extensions");
    }
    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: expectation.expectedRelativeDir,
      ...("vitest" in expectation ? { vitest: expectation.vitest } : {}),
      ...("execArgv" in expectation ? { execArgv: [...expectation.execArgv] } : {}),
    });
  });

  it("falls back to source extensions when dist trees exist but do not contain real plugin manifests", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-incomplete-built-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions", "discord"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions", "discord"), {
      recursive: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: "extensions",
    });
  });

  it("uses source extensions in pnpm workspace mirrors without git metadata", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-source-mirror-",
      hasExtensions: true,
      hasSrc: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(repoRoot, "extensions", "memory-core");

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: "extensions",
    });
  });

  it("keeps built bundled plugins for git-looking trees without pnpm workspace metadata", () => {
    const repoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-git-no-pnpm-",
      hasExtensions: true,
      hasSrc: true,
      hasDistRuntimeExtensions: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(repoRoot, "extensions");
    seedBundledPluginTree(repoRoot, path.join("dist", "extensions"));
    seedBundledPluginTree(repoRoot, path.join("dist-runtime", "extensions"));

    expectResolvedBundledDirFromRoot({
      repoRoot,
      expectedRelativeDir: path.join("dist-runtime", "extensions"),
    });
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

    expect(withPluginCache(createPluginCache(), resolveBundledPluginsDir)).toBe(
      path.join(repoRoot, "dist", "extensions"),
    );
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

  it("ignores an existing override under an argv1-derived fake package root", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-argv-override-reject-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));

    vi.spyOn(process, "cwd").mockReturnValue(installedRoot);
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(installedRoot, "dist", "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

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

  it("does not let VITEST add cwd to bundled plugin resolution candidates", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-vitest-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    seedBundledPluginTree(cwdRepoRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    process.env.VITEST = "true";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it("falls back from a missing override instead of returning an untrusted future path", () => {
    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-missing-cwd-"));
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    const missingOverride = path.join(
      makeRepoRoot("openclaw-bundled-dir-missing-override-"),
      "extensions",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = missingOverride;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(path.resolve(bundledDir)).not.toBe(path.resolve(missingOverride));
  });

  it("falls back to argv root when an existing rejected override is unrelated", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-rejected-override-argv-",
      hasDistExtensions: true,
    });
    seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
    const overrideRoot = makeRepoRoot("openclaw-bundled-dir-rejected-override-");
    seedBundledPluginTree(overrideRoot, "extensions", "memory-core");

    vi.spyOn(process, "cwd").mockReturnValue(makeRepoRoot("openclaw-bundled-dir-rejected-cwd-"));
    process.argv[1] = path.join(installedRoot, "openclaw.mjs");
    process.execArgv.length = 0;
    delete process.env.VITEST;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(overrideRoot, "extensions");
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = resolveBundledPluginsDir();

    expect(fs.realpathSync(bundledDir ?? "")).toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });

  it("ignores an enclosing checkout reached through node_modules tooling argv1", () => {
    // Nested git worktrees (.worktrees/<pr>, .claude/worktrees/*) have no local
    // node_modules, so vitest workers run with argv1 inside the enclosing
    // checkout's node_modules. That checkout's (possibly stale) bundled plugin
    // trees must never win discovery over the checkout under test.
    const outerRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-enclosing-",
      hasExtensions: true,
      hasSrc: true,
      hasDistExtensions: true,
      hasGitCheckout: true,
      hasPnpmWorkspace: true,
    });
    seedBundledPluginTree(outerRoot, "extensions");
    seedBundledPluginTree(outerRoot, path.join("dist", "extensions"));
    const workerArgv1 = path.join(
      outerRoot,
      "node_modules",
      "vitest",
      "dist",
      "workers",
      "threads.js",
    );
    fs.mkdirSync(path.dirname(workerArgv1), { recursive: true });
    fs.writeFileSync(workerArgv1, "", "utf8");
    const nestedWorktree = path.join(outerRoot, ".worktrees", "pr-1234");
    fs.mkdirSync(nestedWorktree, { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(nestedWorktree);
    process.argv[1] = workerArgv1;
    process.execArgv.length = 0;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(outerRoot, "dist", "extensions")),
    );
    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(outerRoot, "extensions")),
    );
  });

  it("does not resolve bundled plugins from cwd when argv1 is not a package root", () => {
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-untrusted-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });
    fs.mkdirSync(path.join(cwdRepoRoot, "extensions", "memory-core"), { recursive: true });
    fs.writeFileSync(
      path.join(cwdRepoRoot, "extensions", "memory-core", "runtime-api.js"),
      "export const marker = 'untrusted-cwd';\n",
      "utf8",
    );
    vi.spyOn(process, "cwd").mockReturnValue(cwdRepoRoot);
    process.argv[1] = "/usr/bin/env";
    process.execArgv.length = 0;
    delete process.env.VITEST;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    const bundledDir = requireBundledDir(resolveBundledPluginsDir());

    expect(fs.realpathSync(bundledDir)).not.toBe(
      fs.realpathSync(path.join(cwdRepoRoot, "extensions")),
    );
  });

  it.each([
    {
      name: "prefers the running CLI package root over an unrelated cwd checkout",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-installed-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        const cwdRepoRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-cwd-",
          hasExtensions: true,
          hasSrc: true,
          hasGitCheckout: true,
        });
        return {
          installedRoot,
          cwd: cwdRepoRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
        };
      },
    },
    {
      name: "falls back to the running installed package when the override path is stale",
      createScenario: () => {
        const installedRoot = createOpenClawRoot({
          prefix: "openclaw-bundled-dir-override-",
          hasDistExtensions: true,
        });
        seedBundledPluginTree(installedRoot, path.join("dist", "extensions"));
        return {
          installedRoot,
          argv1: path.join(installedRoot, "openclaw.mjs"),
          bundledDirOverride: path.join(installedRoot, "missing-extensions"),
        };
      },
    },
  ] as const)("$name", ({ createScenario }) => {
    expectInstalledBundledDirScenarioCase(createScenario);
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
