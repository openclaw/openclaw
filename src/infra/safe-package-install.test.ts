import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

const npmPackageRoot = path.dirname(createRequire(import.meta.url).resolve("npm/package.json"));

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

function npmFixture(dir: string, userConfig = "") {
  const write = (name: string, content: string) => {
    const file = path.join(dir, name);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, content, "utf-8");
    return file;
  };
  const home = path.join(dir, "home");
  fsSync.mkdirSync(home);
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    NPM_CONFIG_USERCONFIG: write("user.npmrc", userConfig),
    NPM_CONFIG_GLOBALCONFIG: write("global.npmrc", ""),
  };
  return {
    write,
    env,
    read: (
      extra: NodeJS.ProcessEnv = {},
      options: Parameters<typeof createSafeNpmInstallEnv>[1] = {},
    ) => createSafeNpmInstallEnv({ ...env, ...extra }, { npmConfigCwd: dir, ...options }),
  };
}
const expectPolicies = (env: NodeJS.ProcessEnv, git?: string, remote?: string) => {
  expect([env.npm_config_allow_git, env.npm_config_allow_remote]).toEqual([git, remote]);
};
const npmValues = (value: string | undefined, names: string) =>
  Object.fromEntries(names.split(" ").map((name) => [`npm_config_${name}`, value]));

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
    ).toEqual(
      "install --omit=dev --omit=peer --legacy-peer-deps --loglevel=error --ignore-scripts --workspaces=false --no-audit --no-fund".split(
        " ",
      ),
    );
  });

  it.each([
    {
      label: "forces project-local script-free npm install env",
      env: {
        PATH: "/usr/bin:/bin",
        NPM_CONFIG_ALLOW_GIT: "none",
        NPM_CONFIG_ALLOW_REMOTE: "none",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
        NPM_CONFIG_LEGACY_PEER_DEPS: "false",
        NPM_CONFIG_STRICT_PEER_DEPS: "true",
        ...npmValues("true", "global include_workspace_root package_lock workspaces"),
        npm_config_ignore_scripts: "false",
        npm_config_location: "global",
        npm_config_workspace: "extensions/telegram",
      },
      options: {
        cacheDir: "/tmp/openclaw-npm-cache",
        ignoreWorkspaces: true,
        legacyPeerDeps: true,
        packageLock: false,
        quiet: true,
      },
      expected: {
        PATH: "/usr/bin:/bin",
        NPM_CONFIG_ALLOW_GIT: "none",
        NPM_CONFIG_ALLOW_REMOTE: "none",
        NPM_CONFIG_BEFORE: "",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        ...npmValues(
          "false",
          "audit dry_run fund global package_lock progress save strict_peer_deps workspaces",
        ),
        ...npmValues("", "before min-release-age"),
        npm_config_cache: "/tmp/openclaw-npm-cache",
        npm_config_fetch_retries: "5",
        npm_config_fetch_retry_maxtimeout: "120000",
        npm_config_fetch_retry_mintimeout: "10000",
        npm_config_fetch_timeout: "300000",
        ...npmValues("true", "ignore_scripts legacy_peer_deps yes"),
        npm_config_location: "project",
        npm_config_loglevel: "error",
        npm_config_min_release_age: "0",
        ...npmValues(undefined, "allow_git allow_remote include_workspace_root workspace"),
      },
    },
    {
      label: "does not inherit host legacy peer dependency mode by default",
      env: {
        PATH: "/usr/bin:/bin",
        ...npmValues("true", "legacy_peer_deps strict_peer_deps"),
      },
      expected: {
        PATH: "/usr/bin:/bin",
        ...npmValues("false", "legacy_peer_deps strict_peer_deps"),
      },
    },
    {
      label: "allows package-lock-enabled installs to write lockfiles",
      env: { npm_config_save: "false" },
      options: { packageLock: true },
      expected: { npm_config_package_lock: "true", npm_config_save: "true" },
    },
  ])("$label", ({ env, options, expected }) => {
    const actual = createSafeNpmInstallEnv(env, options);
    expect(Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]))).toEqual(
      expected,
    );
  });

  it.each([
    ["native defaults", "", "all", "all", false],
    ["Windows Git", '"allow-git"=none\n', undefined, "all", true],
    ["Windows remote", "'allow-remote'=root\n", "all", undefined, true],
  ] as const)(
    "preserves dependency-source policy: %s",
    async (_name, npmrc, expectedGit, expectedRemote, windows) => {
      await withTempDir("openclaw-windows-npm-source-policy-", async (dir) => {
        const fixture = npmFixture(dir, npmrc);
        if (windows) {
          withWindowsNpmToolchain(dir, (nodeDir) =>
            expectPolicies(
              fixture.read({ PATH: nodeDir, PATHEXT: ".EXE;.CMD" }),
              expectedGit,
              expectedRemote,
            ),
          );
        } else {
          expectPolicies(fixture.read(), expectedGit, expectedRemote);
        }
      });
    },
  );

  it.each([false, true])(
    "preserves quoted dependency-source restrictions (redirected=%s)",
    async (redirected) => {
      await withTempDir("openclaw-npm-source-policy-", async (dir) => {
        const { env, write } = npmFixture(dir);
        if (redirected) {
          write(".npmrc", `userconfig=${env.NPM_CONFIG_USERCONFIG}\n`);
        }
        write(
          "user.npmrc",
          `"allow-git"=none\n${redirected ? `globalconfig=${env.NPM_CONFIG_GLOBALCONFIG}\n` : ""}`,
        );
        write("global.npmrc", "'allow-remote'=root\n");
        expectPolicies(
          createSafeNpmInstallEnv(
            redirected ? { HOME: env.HOME } : { ...env, npm_config_json: "true" },
            { npmConfigCwd: dir },
          ),
        );
      });
    },
  );

  it("uses only effective section and prefix source policies", async () => {
    await withTempDir("openclaw-npm-source-policy-", async (dir) => {
      const { write, env } = npmFixture(dir);
      write(".npmrc", "[other]\nallow-git=none\n");
      write("parent-prefix/etc/npmrc", "allow-git=none\n");
      write("scoped-prefix/etc/npmrc", "'allow-remote'=root\n");
      write("package.json", '{"publishConfig":{"allow-git":"none","allow-remote":"none"}}');
      expectPolicies(
        createSafeNpmInstallEnv(
          {
            HOME: env.HOME,
            NPM_CONFIG_PREFIX: path.join(dir, "parent-prefix"),
            npm_config_long: "true",
          },
          { npmConfigCwd: dir, npmConfigPrefix: path.join(dir, "scoped-prefix") },
        ),
        "all",
      );
    });
  });
});
