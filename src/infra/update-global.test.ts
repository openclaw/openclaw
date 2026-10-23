import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import * as exec from "../process/exec.js";
import { captureEnv } from "../test-utils/env.js";
import {
  withMockedPlatform,
  withMockedWindowsPlatform,
  withRestoredMocks,
  mockProcessPlatform,
} from "../test-utils/vitest-spies.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import {
  canResolveRegistryVersionForPackageTarget,
  collectInstalledGlobalPackageErrors,
  cleanupGlobalRenameDirs,
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  createGlobalInstallEnv,
  globalInstallArgs,
  isPackageTargetAlreadyCurrent,
  resolveExpectedInstalledVersionFromSpec,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
} from "./update-global.js";
import { resolvePnpmGlobalDirFromGlobalRoot } from "./update-native-package-owner.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  resolveNpmGlobalPrefixLayoutFromPrefix,
} from "./update-npm-prefix.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function commandResult(stdout: string, code = 0) {
  return { stdout, stderr: "", code };
}

async function npmFixture(prefix: string, name = "openclaw") {
  const globalRoot = path.join(prefix, "lib/node_modules");
  const pkgRoot = path.join(globalRoot, name);
  await fs.mkdir(pkgRoot, { recursive: true });
  return { globalRoot, pkgRoot };
}

function npmTarget(globalRoot: string, packageRoot: string, version: string | null = "12.0.0") {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot,
    npmOwner: { version, lifecyclePolicy: version ? "allow-scripts" : null },
  };
}

async function expectPackageError(packageRoot: string, error: string) {
  expect(await collectInstalledGlobalPackageErrors({ packageRoot })).toContain(error);
}

function resolveTarget(
  runCommand: CommandRunner,
  pkgRoot?: string,
  options: Partial<
    Omit<Parameters<typeof resolveGlobalInstallTarget>[0], "runCommand" | "pkgRoot" | "timeoutMs">
  > = {},
) {
  return resolveGlobalInstallTarget({
    manager: "npm",
    runCommand,
    timeoutMs: 1000,
    pkgRoot,
    ...options,
  });
}

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));
const TELEGRAM_RUNTIME_API = bundledDistPluginFile("telegram", "runtime-api.js");
const expectedNpmInstall =
  "npm i -g --allow-scripts=openclaw openclaw@latest --no-fund --no-audit --loglevel=error --min-release-age=0".split(
    " ",
  );

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

async function writeGlobalPackageJson(packageRoot: string, version = "1.0.0") {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf-8",
  );
}

async function writeBundledPluginPackageJson(
  packageRoot: string,
  pluginId: string,
  packageName: string,
) {
  const packageJsonPath = path.join(packageRoot, "dist/extensions", pluginId, "package.json");
  await fs.mkdir(path.dirname(packageJsonPath), { recursive: true });
  await fs.writeFile(packageJsonPath, JSON.stringify({ name: packageName }), "utf-8");
}

async function writeFixture(root: string, relative: string, content = "export {};\n") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

function createNpmRootRunner(defaultNpmRoot: string): CommandRunner {
  return rootRunner({ npm: defaultNpmRoot, pnpm: null }, "12.0.0");
}

function rootRunner(roots: Record<string, string | null>, version?: string): CommandRunner {
  return async (argv) => {
    if (version && argv[1] === "--version") {
      return commandResult(`${version}\n`);
    }
    const command = argv[0];
    if (!command || !(command in roots)) {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    const root = roots[command];
    return commandResult(root ? `${root}\n` : "", root ? 0 : 1);
  };
}

describe("update global helpers", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;

  afterEach(() => {
    execFileSyncMock.mockClear();
    envSnapshot?.restore();
    envSnapshot = undefined;
  });

  it("prefers explicit package spec overrides", () => {
    envSnapshot = captureEnv(["OPENCLAW_UPDATE_PACKAGE_SPEC"]);
    process.env.OPENCLAW_UPDATE_PACKAGE_SPEC = "file:/tmp/openclaw.tgz";

    expect(resolveGlobalInstallSpec({ packageName: "openclaw", tag: "latest" })).toBe(
      "file:/tmp/openclaw.tgz",
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "beta",
        env: { OPENCLAW_UPDATE_PACKAGE_SPEC: "openclaw@next" },
      }),
    ).toBe("openclaw@next");
  });

  it.each([
    ["main", "github:openclaw/openclaw#main"],
    ["github:openclaw/openclaw#feature/my-branch", "github:openclaw/openclaw#feature/my-branch"],
    ["https://example.com/openclaw-main.tgz", "https://example.com/openclaw-main.tgz"],
  ] as const)("maps package target %s to its install spec", (tag, expected) => {
    expect(resolveGlobalInstallSpec({ packageName: "openclaw", tag })).toBe(expected);
  });

  it.each([
    { spec: "other@1.2.3", expected: null },
    { spec: "openclaw@^1.2.3", expected: null },
    { spec: "openclaw@=v1.2.3", expected: "1.2.3" },
  ])("derives an exact installed version from $spec", ({ spec, expected }) => {
    expect(resolveExpectedInstalledVersionFromSpec("openclaw", spec)).toBe(expected);
  });

  it("recognizes the installed version of a pinned package target", () => {
    expect(
      isPackageTargetAlreadyCurrent({
        currentVersion: "1.0.0",
        targetVersion: "1.0.0",
        target: "openclaw@1.0.0",
      }),
    ).toBe(true);
  });

  it("passes a source package target through without registry resolution", () => {
    expect(canResolveRegistryVersionForPackageTarget("openclaw/openclaw#main")).toBe(false);
    expect(
      resolveGlobalInstallSpec({ packageName: "openclaw", tag: "openclaw/openclaw#main", env: {} }),
    ).toBe("openclaw/openclaw#main");
  });

  it("resolves scoped package paths from the package manager global root", async () => {
    const globalRoot = path.join("tmp/npm-root");
    const runCommand: CommandRunner = async () => commandResult(`${globalRoot}\n`);

    await expect(
      resolveTarget(runCommand, undefined, { packageName: "@kevins8/openclaw" }),
    ).resolves.toMatchObject({
      manager: "npm",
      globalRoot,
      packageRoot: path.join(globalRoot, "@kevins8/openclaw"),
    });
  });

  it.each([
    ["11.15.9", "unflagged"],
    ["11.16.0", "allow-scripts-advisory"],
  ] as const)("binds npm %s lifecycle policy to the owning executable", async (version, policy) => {
    const prefix = dirs.make("openclaw-npm-owner-");

    const { globalRoot, pkgRoot: packageRoot } = await npmFixture(prefix);
    const owningNpm = path.join(prefix, "bin/npm");
    await writeFixture(prefix, "bin/npm", "");
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] === owningNpm && argv[1] === "root") {
        return commandResult(`${globalRoot}\n`);
      }
      if (argv[0] === owningNpm && argv[1] === "--version") {
        return commandResult(`${version}\n`);
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };

    await expect(
      resolveTarget(runCommand, packageRoot, { packageName: "openclaw" }),
    ).resolves.toMatchObject({
      command: owningNpm,
      npmOwner: { version, lifecyclePolicy: policy },
    });
    expect(calls).toContainEqual([owningNpm, "--version"]);
    expect(calls).not.toContainEqual(["npm", "--version"]);
  });

  it("defaults corepack download prompts off for global install env", async () => {
    const defaultEnv = await createGlobalInstallEnv({});
    expect(defaultEnv).toMatchObject({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      NPM_CONFIG_BEFORE: "",
      npm_config_before: "",
      "npm_config_min-release-age": "",
      npm_config_min_release_age: "0",
    });

    const explicitEnv = await createGlobalInstallEnv({ COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" });
    expect(explicitEnv?.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("1");
  });

  it("sets the package launcher under Bun", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.3" } });
    try {
      expect((await createGlobalInstallEnv({}))?.OPENCLAW_PACKAGE_BUN_LAUNCHER).toBe(
        process.execPath,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses an absolute POSIX script shell for npm lifecycle scripts during global installs", async () => {
    await withMockedPlatform("linux", async () => {
      const existsSyncSpy = vi
        .spyOn(fsSync, "existsSync")
        .mockImplementation((candidate) => candidate === "/bin/sh");
      await withRestoredMocks([existsSyncSpy], async () => {
        const env = await createGlobalInstallEnv({
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          PATH: "/home/peter/.npm-global/bin",
        });
        expect(env).toMatchObject({
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          NPM_CONFIG_SCRIPT_SHELL: "/bin/sh",
        });
      });
    });
  });

  it.each([
    ["NPM_CONFIG_SCRIPT_SHELL", "/custom/sh"],
    ["npm_config_script_shell", "/custom/lower-sh"],
  ] as const)("preserves explicit %s for global installs", async (key, value) => {
    await withMockedPlatform("linux", async () => {
      expect(
        await createGlobalInstallEnv({
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          [key]: value,
        }),
      ).toMatchObject({ [key]: value });
    });
  });

  it("resolves portable Git paths from process-local app data only", async () => {
    await withMockedWindowsPlatform(async () => {
      const base = dirs.make("openclaw-update-portable-git-");

      envSnapshot = captureEnv(["LOCALAPPDATA"]);
      const injectedLocalAppData = path.join(base, "injected-local-app-data");
      const trustedLocalAppData = path.join(base, "trusted-local-app-data");
      const injectedGitDir = path.join(injectedLocalAppData, "OpenClaw/deps/portable-git/cmd");
      const trustedGitDir = path.join(trustedLocalAppData, "OpenClaw/deps/portable-git/cmd");
      await fs.mkdir(injectedGitDir, { recursive: true });
      await fs.mkdir(trustedGitDir, { recursive: true });

      delete process.env.LOCALAPPDATA;
      const injectedOnlyEnv = await createGlobalInstallEnv({
        LOCALAPPDATA: injectedLocalAppData,
        PATH: "base-bin",
      });
      expect(injectedOnlyEnv?.PATH).not.toContain(injectedGitDir);

      process.env.LOCALAPPDATA = trustedLocalAppData;
      const trustedEnv = await createGlobalInstallEnv({
        LOCALAPPDATA: injectedLocalAppData,
        PATH: "base-bin",
      });
      expect(trustedEnv?.PATH).toContain(trustedGitDir);
      expect(trustedEnv?.PATH).not.toContain(injectedGitDir);
    });
  });

  it("detects install managers from resolved roots and on-disk presence", async () => {
    const base = dirs.make("openclaw-update-global-");

    const npmRoot = path.join(base, "npm-root");
    const pnpmRoot = path.join(base, "pnpm-root");
    const bunRoot = path.join(base, ".bun/install/global/node_modules");
    const pkgRoot = path.join(pnpmRoot, "openclaw");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.mkdir(path.join(npmRoot, "openclaw"), { recursive: true });
    await fs.mkdir(path.join(bunRoot, "openclaw"), { recursive: true });

    envSnapshot = captureEnv(["BUN_INSTALL"]);
    process.env.BUN_INSTALL = path.join(base, ".bun");

    const runCommand = rootRunner({ npm: npmRoot, pnpm: pnpmRoot });

    await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
      "pnpm",
    );
    await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("npm");

    await fs.rm(path.join(npmRoot, "openclaw"), { recursive: true, force: true });
    await fs.rm(path.join(pnpmRoot, "openclaw"), { recursive: true, force: true });
    await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("bun");
  });

  it("keeps scoped npm self-updates on the running package root", async () => {
    await withMockedPlatform("darwin", async () => {
      const base = dirs.make("openclaw-update-scoped-probe-");

      // A foreign PATH Node can make the nvm npm report a Homebrew destination.
      const nvmPrefix = path.join(base, "home/.nvm/versions/node/v24.5.0");
      const { globalRoot: nvmRoot, pkgRoot } = await npmFixture(nvmPrefix, "@scope/cli");
      const cellarRoot = path.join(base, "opt/homebrew/Cellar/node/26.3.1/lib/node_modules");

      const runCommand = vi.fn(createNpmRootRunner(cellarRoot));

      await expect(
        resolveTarget(runCommand, pkgRoot, { packageName: "@scope/cli" }),
      ).resolves.toEqual(npmTarget(nvmRoot, pkgRoot));
      expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([["npm", "--version"]]);
    });
  });

  it("falls back to the running package root when the npm root probe fails", async () => {
    await withMockedPlatform("darwin", async () => {
      const base = dirs.make("openclaw-update-probe-failure-");

      const { globalRoot, pkgRoot } = await npmFixture(path.join(base, "usr/local"));

      const runCommand: CommandRunner = async () => commandResult("", 1);

      await expect(resolveTarget(runCommand, pkgRoot)).resolves.toEqual(
        npmTarget(globalRoot, pkgRoot, null),
      );
    });
  });

  it("does not infer npm ownership from path shape alone when the owning npm binary is absent", async () => {
    const base = dirs.make("openclaw-update-npm-missing-bin-");

    const { pkgRoot } = await npmFixture(path.join(base, "opt/homebrew"));
    const pathNpmRoot = path.join(base, "nvm/lib/node_modules");

    const runCommand = createNpmRootRunner(pathNpmRoot);

    await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBeNull();
    expect(globalInstallArgs("npm", "openclaw@latest", pkgRoot)).toEqual(expectedNpmInstall);
  });

  it("honors an explicitly selected direct npm node_modules package root", async () => {
    const base = dirs.make("openclaw-update-managed-service-root-");

    const managedNpmRoot = path.join(base, ".openclaw/npm/node_modules");
    const pkgRoot = path.join(managedNpmRoot, "openclaw");
    const pathNpmRoot = path.join(base, "shell/lib/node_modules");
    const otherPnpmRoot = path.join(base, "pnpm/global/5/node_modules");
    const customNpm = path.join(base, "bin/npm");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.mkdir(path.join(otherPnpmRoot, "openclaw"), { recursive: true });

    const runCommand = rootRunner(
      {
        npm: pathNpmRoot,
        [customNpm]: pathNpmRoot,
        pnpm: otherPnpmRoot,
      },
      "12.0.0",
    );

    for (const [manager, command] of [
      ["pnpm", "npm"],
      [{ manager: "npm", command: customNpm }, customNpm],
    ] as const) {
      await expect(
        resolveTarget(runCommand, pkgRoot, { manager, honorPackageRoot: true }),
      ).resolves.toEqual({
        ...npmTarget(managedNpmRoot, pkgRoot),
        command,
        directNodeModulesRoot: true,
      });
    }

    expect(
      resolveNpmGlobalPrefixLayoutFromGlobalRoot(managedNpmRoot, {
        allowDirectNodeModulesRoot: true,
      }),
    ).toEqual({
      prefix: path.dirname(managedNpmRoot),
      globalRoot: managedNpmRoot,
      binDir: path.join(managedNpmRoot, ".bin"),
    });
  });

  it.each([
    ["the running package root", false],
    ["virtual-store package roots", true],
  ] as const)("detects custom pnpm global layouts from %s", async (_name, virtualStore) => {
    const base = dirs.make("update-pnpm-");

    const customGlobalDir = path.join(base, "custom-pnpm");
    const customGlobalRoot = path.join(customGlobalDir, "5/node_modules");
    const packageRoot = path.join(customGlobalRoot, "openclaw");
    const pkgRoot = virtualStore
      ? path.join(
          customGlobalDir,
          "5/.pnpm/openclaw@file+..+pack+openclaw-2026.5.6.tgz/node_modules/openclaw",
        )
      : packageRoot;
    const defaultPnpmRoot = path.join(base, "default-pnpm/5/node_modules");
    await fs.mkdir(customGlobalRoot, { recursive: true });
    await fs.mkdir(pkgRoot, { recursive: true });
    await writeFixture(customGlobalDir, "5/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await writeFixture(customGlobalRoot, ".modules.yaml", "layoutVersion: 5\n");
    const runCommand = rootRunner({ npm: null, pnpm: defaultPnpmRoot });

    await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
      "pnpm",
    );
    await expect(
      resolveTarget(
        runCommand,
        pkgRoot,
        virtualStore
          ? { manager: "pnpm" as const }
          : {
              manager: { manager: "pnpm" as const, command: "/custom/bin/pnpm" },
              honorPackageRoot: true,
            },
      ),
    ).resolves.toEqual({
      manager: "pnpm",
      command: virtualStore ? "pnpm" : "/custom/bin/pnpm",
      globalRoot: customGlobalRoot,
      packageRoot,
    });
    if (!virtualStore) {
      expect(resolvePnpmGlobalDirFromGlobalRoot(customGlobalRoot)).toBe(customGlobalDir);
    }
  });

  it("builds npm global install argv", () => {
    expect(globalInstallArgs("npm", "openclaw@latest")).toEqual(expectedNpmInstall);
  });
  it.each(["openclaw@latest", "github:openclaw/openclaw#release/2026.5.12"])(
    "allows only OpenClaw builds for pnpm target %s",
    (spec) => {
      expect(globalInstallArgs("pnpm", spec)).toEqual([
        "pnpm",
        "add",
        "-g",
        "--allow-build=openclaw",
        spec,
      ]);
    },
  );
  it.each([
    ["openclaw@latest", "openclaw@latest"],
    ["/tmp/openclaw-current.tgz", "openclaw@file:/tmp/openclaw-current.tgz"],
    ["https://example.test/openclaw.tgz", "openclaw@https://example.test/openclaw.tgz"],
    ["github:openclaw/openclaw#main", "openclaw@github:openclaw/openclaw#main"],
  ] as const)("replaces Bun's global dependency for %s", (spec, expected) => {
    const command = process.versions.bun ? process.execPath : "bun";
    expect(globalInstallArgs("bun", spec)).toEqual([command, "add", "-g", "--trust", expected]);
  });

  it("resolves npm prefix layouts for normal global roots", () => {
    expect(resolveNpmGlobalPrefixLayoutFromGlobalRoot("/opt/openclaw/lib/node_modules")).toEqual({
      prefix: "/opt/openclaw",
      globalRoot: "/opt/openclaw/lib/node_modules",
      binDir: "/opt/openclaw/bin",
    });
    expect(resolveNpmGlobalPrefixLayoutFromPrefix("/tmp/stage")).toEqual({
      prefix: "/tmp/stage",
      globalRoot: "/tmp/stage/lib/node_modules",
      binDir: "/tmp/stage/bin",
    });
    expect(resolveNpmGlobalPrefixLayoutFromGlobalRoot("/tmp/node_modules")).toBeNull();
  });

  it.each(["missing", "failed"] as const)(
    "cleans only renamed package directories when pacman is %s",
    async (probe) => {
      await withRestoredMocks(
        [
          mockProcessPlatform("linux"),
          vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(
            pkgQueryResult(
              "",
              probe === "missing"
                ? {
                    code: null,
                    termination: "error",
                    error: Object.assign(new Error("pacman unavailable"), { code: "ENOENT" }),
                  }
                : { code: 1 },
            ),
          ),
        ],
        async () => {
          const root = dirs.make("openclaw-update-cleanup-");
          await fs.mkdir(path.join(root, ".openclaw-123"), { recursive: true });
          await fs.mkdir(path.join(root, ".openclaw-456"), { recursive: true });
          await fs.writeFile(path.join(root, ".openclaw-file"), "nope", "utf8");
          await fs.mkdir(path.join(root, "openclaw"), { recursive: true });

          const result = await cleanupGlobalRenameDirs({
            globalRoot: root,
            packageName: "openclaw",
          });
          expect(result.removed.toSorted()).toEqual([".openclaw-123", ".openclaw-456"]);
          expect((await fs.readdir(root)).toSorted()).toEqual([".openclaw-file", "openclaw"]);
          expect((await fs.stat(path.join(root, "openclaw"))).isDirectory()).toBe(true);
          expect((await fs.stat(path.join(root, ".openclaw-file"))).isFile()).toBe(true);
        },
      );
    },
  );

  it("checks installed dist against the packaged inventory", async () => {
    const packageRoot = dirs.make("openclaw-update-global-pkg-");

    await writeGlobalPackageJson(packageRoot);
    for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
      await writeFixture(packageRoot, relativePath);
    }
    await writePackageDistInventory(packageRoot);

    await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toStrictEqual([]);

    await fs.rm(path.join(packageRoot, TELEGRAM_RUNTIME_API));
    await expectPackageError(packageRoot, `missing packaged dist file ${TELEGRAM_RUNTIME_API}`);

    const stale = "dist/extensions/telegram/.openclaw-install-stage/node_modules/typebox/code.mjs";
    await writeFixture(packageRoot, stale);
    await expectPackageError(packageRoot, `unexpected packaged dist file ${stale}`);
  });

  it("flags global package roots that resolve into source checkouts", async () => {
    const base = dirs.make("openclaw-update-global-source-checkout-");

    const checkoutRoot = path.join(base, "checkout");
    const globalRoot = path.join(base, "prefix/lib/node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    for (const directory of [".git", "src", "extensions"]) {
      await fs.mkdir(path.join(checkoutRoot, directory), { recursive: true });
    }
    await writeFixture(checkoutRoot, "pnpm-workspace.yaml", "packages: []\n");
    await writeGlobalPackageJson(checkoutRoot, "2026.4.27");
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.symlink(checkoutRoot, packageRoot, "dir");
    const realCheckoutRoot = await fs.realpath(checkoutRoot);

    await expectPackageError(
      packageRoot,
      `global package root resolves to source checkout: ${realCheckoutRoot}`,
    );
  });

  it("fails closed on newer installs when the inventory is missing", async () => {
    const packageRoot = dirs.make("openclaw-update-global-missing-inventory-new-");
    await writeGlobalPackageJson(packageRoot, "2026.4.15");
    await expectPackageError(
      packageRoot,
      `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
    );
  });

  it("rejects invalid inventory files during global verify", async () => {
    const packageRoot = dirs.make("openclaw-update-global-invalid-inventory-");

    await writeGlobalPackageJson(packageRoot, "2026.4.15");
    await writeFixture(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH, "{not-json}\n");

    await expectPackageError(
      packageRoot,
      `invalid package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
    );
  });

  it.each([false, true])(
    "enforces critical bundled sidecars with inventory present: %s",
    async (inventory) => {
      const packageRoot = dirs.make("openclaw-update-global-sidecars-");
      await writeGlobalPackageJson(packageRoot, inventory ? "2026.4.15" : "1.0.0");
      await writeBundledPluginPackageJson(packageRoot, "telegram", "@openclaw/telegram");
      if (inventory) {
        await writePackageDistInventory(packageRoot);
      }
      await expectPackageError(
        packageRoot,
        `missing bundled runtime sidecar ${TELEGRAM_RUNTIME_API}`,
      );
    },
  );
});
