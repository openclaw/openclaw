// Covers script-free npm install args and environment.
import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

const require = createRequire(import.meta.url);
const npmPackageRoot = path.dirname(require.resolve("npm/package.json"));

function withWindowsNpmToolchain<T>(dir: string, run: (nodeDir: string) => T): T {
  const nodeDir = path.join(dir, "node-toolchain");
  const nodeExecutable = path.join(nodeDir, "node.exe");
  fsSync.mkdirSync(path.join(nodeDir, "node_modules"), { recursive: true });
  if (process.platform === "win32") {
    try {
      fsSync.linkSync(process.execPath, nodeExecutable);
    } catch {
      fsSync.copyFileSync(process.execPath, nodeExecutable);
    }
  } else {
    fsSync.symlinkSync(process.execPath, nodeExecutable);
  }
  fsSync.symlinkSync(npmPackageRoot, path.join(nodeDir, "node_modules", "npm"), "junction");

  const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "execPath", {
    configurable: true,
    enumerable: true,
    value: nodeExecutable,
    writable: true,
  });
  try {
    return withMockedWindowsPlatform(() => run(nodeDir));
  } finally {
    if (originalExecPath) {
      Object.defineProperty(process, "execPath", originalExecPath);
    }
  }
}

describe("safe npm install helpers", () => {
  it("builds script-free npm install args", () => {
    expect(
      createSafeNpmInstallArgs({
        omitPeer: true,
        legacyPeerDeps: true,
        ignoreWorkspaces: true,
        noAudit: true,
        noFund: true,
      }),
    ).toEqual([
      "install",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--loglevel=error",
      "--ignore-scripts",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it.each([
    {
      label: "forces project-local script-free npm install env",
      create: () =>
        createSafeNpmInstallEnv(
          {
            PATH: "/usr/bin:/bin",
            NPM_CONFIG_ALLOW_GIT: "none",
            NPM_CONFIG_ALLOW_REMOTE: "none",
            NPM_CONFIG_IGNORE_SCRIPTS: "false",
            NPM_CONFIG_LEGACY_PEER_DEPS: "false",
            NPM_CONFIG_STRICT_PEER_DEPS: "true",
            npm_config_global: "true",
            npm_config_include_workspace_root: "true",
            npm_config_ignore_scripts: "false",
            npm_config_location: "global",
            npm_config_package_lock: "true",
            npm_config_workspace: "extensions/telegram",
            npm_config_workspaces: "true",
          },
          {
            cacheDir: "/tmp/openclaw-npm-cache",
            ignoreWorkspaces: true,
            legacyPeerDeps: true,
            packageLock: false,
            quiet: true,
          },
        ),
      expected: {
        PATH: "/usr/bin:/bin",
        NPM_CONFIG_ALLOW_GIT: "none",
        NPM_CONFIG_ALLOW_REMOTE: "none",
        NPM_CONFIG_BEFORE: "",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        npm_config_audit: "false",
        npm_config_before: "",
        npm_config_cache: "/tmp/openclaw-npm-cache",
        npm_config_dry_run: "false",
        npm_config_fetch_retries: "5",
        npm_config_fetch_retry_maxtimeout: "120000",
        npm_config_fetch_retry_mintimeout: "10000",
        npm_config_fetch_timeout: "300000",
        npm_config_fund: "false",
        npm_config_global: "false",
        npm_config_ignore_scripts: "true",
        npm_config_legacy_peer_deps: "true",
        npm_config_location: "project",
        npm_config_loglevel: "error",
        npm_config_package_lock: "false",
        npm_config_progress: "false",
        npm_config_save: "false",
        npm_config_strict_peer_deps: "false",
        npm_config_workspaces: "false",
        npm_config_yes: "true",
        "npm_config_min-release-age": "",
        npm_config_min_release_age: "0",
        npm_config_allow_git: undefined,
        npm_config_allow_remote: undefined,
        npm_config_include_workspace_root: undefined,
        npm_config_workspace: undefined,
      },
    },
    {
      label: "does not inherit host legacy peer dependency mode by default",
      create: () =>
        createSafeNpmInstallEnv({
          PATH: "/usr/bin:/bin",
          npm_config_legacy_peer_deps: "true",
          npm_config_strict_peer_deps: "true",
        }),
      expected: {
        PATH: "/usr/bin:/bin",
        npm_config_legacy_peer_deps: "false",
        npm_config_strict_peer_deps: "false",
      },
    },
    {
      label: "allows package-lock-enabled installs to write lockfiles",
      create: () =>
        createSafeNpmInstallEnv(
          {
            PATH: "/usr/bin:/bin",
            npm_config_save: "false",
          },
          {
            packageLock: true,
          },
        ),
      expected: {
        npm_config_package_lock: "true",
        npm_config_save: "true",
      },
    },
  ])("$label", ({ create, expected }) => {
    const env = create();
    for (const [key, value] of Object.entries(expected)) {
      expect(env[key]).toBe(value);
    }
  });

  it("preserves npm 11 dependency-source defaults when no policy is configured", async () => {
    await withTempDir("openclaw-npm-source-policy-", async (dir) => {
      const userconfig = path.join(dir, "user.npmrc");
      const globalconfig = path.join(dir, "global.npmrc");
      fsSync.writeFileSync(userconfig, "", "utf-8");
      fsSync.writeFileSync(globalconfig, "", "utf-8");

      const env = createSafeNpmInstallEnv(
        {
          HOME: dir,
          NPM_CONFIG_GLOBALCONFIG: globalconfig,
          NPM_CONFIG_USERCONFIG: userconfig,
          PATH: process.env.PATH,
        },
        { npmConfigCwd: dir },
      );

      expect(env.npm_config_allow_git).toBe("all");
      expect(env.npm_config_allow_remote).toBe("all");
    });
  });

  it.each([
    {
      name: "explicit Git",
      npmrc: '"allow-git"=none\n',
      expectedGit: undefined,
      expectedRemote: "all",
    },
    {
      name: "explicit remote",
      npmrc: "'allow-remote'=root\n",
      expectedGit: "all",
      expectedRemote: undefined,
    },
  ])(
    "preserves Windows npm source policy when $name",
    async ({ npmrc, expectedGit, expectedRemote }) => {
      await withTempDir("openclaw-windows-npm-source-policy-", async (dir) => {
        const home = path.join(dir, "home");
        const userconfig = path.join(dir, "user.npmrc");
        const globalconfig = path.join(dir, "global.npmrc");
        fsSync.mkdirSync(home, { recursive: true });
        fsSync.writeFileSync(userconfig, npmrc, "utf-8");
        fsSync.writeFileSync(globalconfig, "", "utf-8");

        withWindowsNpmToolchain(dir, (nodeDir) => {
          const env = createSafeNpmInstallEnv(
            {
              HOME: home,
              NPM_CONFIG_GLOBALCONFIG: globalconfig,
              NPM_CONFIG_USERCONFIG: userconfig,
              PATH: nodeDir,
              PATHEXT: ".EXE;.CMD",
            },
            { npmConfigCwd: dir },
          );

          expect(env.npm_config_allow_git).toBe(expectedGit);
          expect(env.npm_config_allow_remote).toBe(expectedRemote);
        });
      });
    },
  );

  it.each([false, true])(
    "preserves quoted dependency-source restrictions (redirected=%s)",
    async (redirected) => {
      await withTempDir("openclaw-npm-source-policy-", async (dir) => {
        const home = path.join(dir, "home");
        const userconfig = path.join(dir, "user.npmrc");
        const globalconfig = path.join(dir, "global.npmrc");
        fsSync.mkdirSync(home, { recursive: true });
        if (redirected) {
          fsSync.writeFileSync(path.join(dir, ".npmrc"), `userconfig=${userconfig}\n`, "utf-8");
        }
        fsSync.writeFileSync(
          userconfig,
          `"allow-git"=none\n${redirected ? `globalconfig=${globalconfig}\n` : ""}`,
          "utf-8",
        );
        fsSync.writeFileSync(globalconfig, "'allow-remote'=root\n", "utf-8");
        const env = createSafeNpmInstallEnv(
          {
            HOME: home,
            ...(redirected
              ? {}
              : {
                  NPM_CONFIG_GLOBALCONFIG: globalconfig,
                  NPM_CONFIG_USERCONFIG: userconfig,
                  npm_config_json: "true",
                }),
          },
          { npmConfigCwd: dir },
        );
        expect(env.npm_config_allow_git).toBeUndefined();
        expect(env.npm_config_allow_remote).toBeUndefined();
      });
    },
  );

  it("uses only effective section and prefix source policies", async () => {
    await withTempDir("openclaw-npm-source-policy-", async (dir) => {
      const home = path.join(dir, "home");
      const parentPrefix = path.join(dir, "parent-prefix");
      const scopedPrefix = path.join(dir, "scoped-prefix");
      fsSync.mkdirSync(home, { recursive: true });
      fsSync.mkdirSync(path.join(parentPrefix, "etc"), { recursive: true });
      fsSync.mkdirSync(path.join(scopedPrefix, "etc"), { recursive: true });
      fsSync.writeFileSync(path.join(dir, ".npmrc"), "[other]\nallow-git=none\n", "utf-8");
      fsSync.writeFileSync(path.join(parentPrefix, "etc", "npmrc"), "allow-git=none\n", "utf-8");
      fsSync.writeFileSync(
        path.join(scopedPrefix, "etc", "npmrc"),
        "'allow-remote'=root\n",
        "utf-8",
      );
      fsSync.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify({
          name: "npm-source-policy-fixture",
          version: "1.0.0",
          publishConfig: {
            "allow-git": "none",
            "allow-remote": "none",
          },
        })}\n`,
        "utf-8",
      );

      const env = createSafeNpmInstallEnv(
        {
          HOME: home,
          NPM_CONFIG_PREFIX: parentPrefix,
          npm_config_long: "true",
        },
        { npmConfigCwd: dir, npmConfigPrefix: scopedPrefix },
      );

      expect(env.npm_config_allow_git).toBe("all");
      expect(env.npm_config_allow_remote).toBeUndefined();
    });
  });
});
