// Covers global update/install command orchestration.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../plugins/runtime-sidecar-paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  withMockedPlatform,
  withMockedWindowsPlatform,
  withRestoredMocks,
} from "../test-utils/vitest-spies.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
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

const execFileSyncMock = vi.hoisted(() => vi.fn(() => "/tmp/openclaw-test-global-npmrc\n"));
const TELEGRAM_RUNTIME_API = bundledDistPluginFile("telegram", "runtime-api.js");

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
  const packageJsonPath = path.join(packageRoot, "dist", "extensions", pluginId, "package.json");
  await fs.mkdir(path.dirname(packageJsonPath), { recursive: true });
  await fs.writeFile(packageJsonPath, JSON.stringify({ name: packageName }), "utf-8");
}

function createNpmRootRunner(defaultNpmRoot: string): CommandRunner {
  return async (argv) => {
    if (argv[1] === "--version") {
      return { stdout: "12.0.0\n", stderr: "", code: 0 };
    }
    if (argv[0] === "npm") {
      return { stdout: `${defaultNpmRoot}\n`, stderr: "", code: 0 };
    }
    if (argv[0] === "pnpm") {
      return { stdout: "", stderr: "", code: 1 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
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

  it("maps main and explicit package targets to install specs", () => {
    expect(resolveGlobalInstallSpec({ packageName: "openclaw", tag: "main" })).toBe(
      "github:openclaw/openclaw#main",
    );
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "github:openclaw/openclaw#feature/my-branch",
      }),
    ).toBe("github:openclaw/openclaw#feature/my-branch");
    expect(
      resolveGlobalInstallSpec({
        packageName: "openclaw",
        tag: "https://example.com/openclaw-main.tgz",
      }),
    ).toBe("https://example.com/openclaw-main.tgz");
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
    const globalRoot = path.join("tmp", "npm-root");
    const runCommand: CommandRunner = async () => ({
      stdout: `${globalRoot}\n`,
      stderr: "",
      code: 0,
    });

    await expect(
      resolveGlobalInstallTarget({
        manager: "npm",
        runCommand,
        timeoutMs: 1000,
        packageName: "@kevins8/openclaw",
      }),
    ).resolves.toMatchObject({
      manager: "npm",
      globalRoot,
      packageRoot: path.join(globalRoot, "@kevins8", "openclaw"),
    });
  });

  it.each([
    ["11.15.9", "unflagged"],
    ["11.16.0", "allow-scripts-advisory"],
  ] as const)("binds npm %s lifecycle policy to the owning executable", async (version, policy) => {
    await withTestDir({ prefix: "openclaw-npm-owner-" }, async (prefix) => {
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const owningNpm = path.join(prefix, "bin", "npm");
      await Promise.all([
        fs.mkdir(packageRoot, { recursive: true }),
        fs.mkdir(path.dirname(owningNpm), { recursive: true }),
      ]);
      await fs.writeFile(owningNpm, "", "utf8");
      const calls: string[][] = [];
      const runCommand: CommandRunner = async (argv) => {
        calls.push(argv);
        if (argv[0] === owningNpm && argv[1] === "root") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === owningNpm && argv[1] === "--version") {
          return { stdout: `${version}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: packageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toMatchObject({
        command: owningNpm,
        npmOwner: {
          version,
          lifecyclePolicy: policy,
        },
      });
      expect(calls).toContainEqual([owningNpm, "--version"]);
      expect(calls).not.toContainEqual(["npm", "--version"]);
    });
  });

  it("defaults corepack download prompts off for global install env", async () => {
    const defaultEnv = await createGlobalInstallEnv({});
    expect(defaultEnv?.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    expect(defaultEnv?.NPM_CONFIG_BEFORE).toBe("");
    expect(defaultEnv?.npm_config_before).toBe("");
    expect(defaultEnv?.["npm_config_min-release-age"]).toBe("");
    expect(defaultEnv?.npm_config_min_release_age).toBe("0");

    const explicitEnv = await createGlobalInstallEnv({
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
    });
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
        expect(env?.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("1");
        expect(env?.NPM_CONFIG_SCRIPT_SHELL).toBe("/bin/sh");
      });
    });
  });

  it("preserves explicit npm script shell config for global installs", async () => {
    await withMockedPlatform("linux", async () => {
      const upperEnv = await createGlobalInstallEnv({
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
        NPM_CONFIG_SCRIPT_SHELL: "/custom/sh",
      });
      expect(upperEnv?.NPM_CONFIG_SCRIPT_SHELL).toBe("/custom/sh");

      const lowerEnv = await createGlobalInstallEnv({
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
        npm_config_script_shell: "/custom/lower-sh",
      });
      expect(lowerEnv?.npm_config_script_shell).toBe("/custom/lower-sh");
    });
  });

  it("resolves portable Git paths from process-local app data only", async () => {
    await withMockedWindowsPlatform(async () => {
      await withTestDir({ prefix: "openclaw-update-portable-git-" }, async (base) => {
        envSnapshot = captureEnv(["LOCALAPPDATA"]);
        const injectedLocalAppData = path.join(base, "injected-local-app-data");
        const trustedLocalAppData = path.join(base, "trusted-local-app-data");
        const injectedGitDir = path.join(
          injectedLocalAppData,
          "OpenClaw",
          "deps",
          "portable-git",
          "cmd",
        );
        const trustedGitDir = path.join(
          trustedLocalAppData,
          "OpenClaw",
          "deps",
          "portable-git",
          "cmd",
        );
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
  });

  it("detects install managers from resolved roots and on-disk presence", async () => {
    await withTestDir({ prefix: "openclaw-update-global-" }, async (base) => {
      const npmRoot = path.join(base, "npm-root");
      const pnpmRoot = path.join(base, "pnpm-root");
      const bunRoot = path.join(base, ".bun", "install", "global", "node_modules");
      const pkgRoot = path.join(pnpmRoot, "openclaw");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.mkdir(path.join(npmRoot, "openclaw"), { recursive: true });
      await fs.mkdir(path.join(bunRoot, "openclaw"), { recursive: true });

      envSnapshot = captureEnv(["BUN_INSTALL"]);
      process.env.BUN_INSTALL = path.join(base, ".bun");

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${pnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("npm");

      await fs.rm(path.join(npmRoot, "openclaw"), { recursive: true, force: true });
      await fs.rm(path.join(pnpmRoot, "openclaw"), { recursive: true, force: true });
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1000)).resolves.toBe("bun");
    });
  });

  it.each([
    {
      name: "keeps scoped npm self-updates on the running package root",
      prefix: "openclaw-update-scoped-probe-",
      packageParts: ["@scope", "cli"],
      packageOptions: { packageName: "@scope/cli" },
    },
  ])("$name", async ({ prefix, packageParts, packageOptions }) => {
    await withMockedPlatform("darwin", async () => {
      await withTestDir({ prefix }, async (base) => {
        // The running install lives in an nvm tree while `npm root -g` on
        // PATH answers with a Homebrew Cellar root — the skew produced when a
        // per-Node npm shim is executed by a foreign node (e.g. a launchd
        // service PATH pairing nvm's npm with Homebrew's node). Installing
        // into the Cellar root would create a brand-new tree the running
        // install never loads from.
        const nvmPrefix = path.join(base, "home", ".nvm", "versions", "node", "v24.5.0");
        const nvmRoot = path.join(nvmPrefix, "lib", "node_modules");
        const pkgRoot = path.join(nvmRoot, ...packageParts);
        const cellarRoot = path.join(
          base,
          "opt",
          "homebrew",
          "Cellar",
          "node",
          "26.3.1",
          "lib",
          "node_modules",
        );
        await fs.mkdir(pkgRoot, { recursive: true });

        const runCommand = vi.fn(createNpmRootRunner(cellarRoot));

        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            runCommand,
            timeoutMs: 1000,
            pkgRoot,
            ...packageOptions,
          }),
        ).resolves.toEqual({
          manager: "npm",
          command: "npm",
          globalRoot: nvmRoot,
          packageRoot: pkgRoot,
          npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
        });
        expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([["npm", "--version"]]);
      });
    });
  });

  it("falls back to the running package root when the npm root probe fails", async () => {
    await withMockedPlatform("darwin", async () => {
      await withTestDir({ prefix: "openclaw-update-probe-failure-" }, async (base) => {
        const globalRoot = path.join(base, "usr", "local", "lib", "node_modules");
        const pkgRoot = path.join(globalRoot, "openclaw");
        await fs.mkdir(pkgRoot, { recursive: true });

        const runCommand: CommandRunner = async () => ({ stdout: "", stderr: "", code: 1 });

        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            runCommand,
            timeoutMs: 1000,
            pkgRoot,
          }),
        ).resolves.toEqual({
          manager: "npm",
          command: "npm",
          globalRoot,
          packageRoot: pkgRoot,
          npmOwner: { version: null, lifecyclePolicy: null },
        });
      });
    });
  });

  it("does not infer npm ownership from path shape alone when the owning npm binary is absent", async () => {
    await withTestDir({ prefix: "openclaw-update-npm-missing-bin-" }, async (base) => {
      const brewRoot = path.join(base, "opt", "homebrew", "lib", "node_modules");
      const pkgRoot = path.join(brewRoot, "openclaw");
      const pathNpmRoot = path.join(base, "nvm", "lib", "node_modules");
      await fs.mkdir(pkgRoot, { recursive: true });

      const runCommand = createNpmRootRunner(pathNpmRoot);

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000),
      ).resolves.toBeNull();
      expect(globalInstallArgs("npm", "openclaw@latest", pkgRoot)).toEqual([
        "npm",
        "i",
        "-g",
        "--allow-scripts=openclaw",
        "openclaw@latest",
        "--no-fund",
        "--no-audit",
        "--loglevel=error",
        "--min-release-age=0",
      ]);
    });
  });

  it("honors an explicitly selected direct npm node_modules package root", async () => {
    await withTestDir({ prefix: "openclaw-update-managed-service-root-" }, async (base) => {
      const managedNpmRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const pkgRoot = path.join(managedNpmRoot, "openclaw");
      const pathNpmRoot = path.join(base, "shell", "lib", "node_modules");
      const otherPnpmRoot = path.join(base, "pnpm", "global", "5", "node_modules");
      const customNpm = path.join(base, "bin", "npm");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.mkdir(path.join(otherPnpmRoot, "openclaw"), { recursive: true });

      const runCommand: CommandRunner = async (argv) => {
        if (argv[1] === "--version") {
          return { stdout: "12.0.0\n", stderr: "", code: 0 };
        }
        if (argv[0] === "npm" || argv[0] === customNpm) {
          return { stdout: `${pathNpmRoot}\n`, stderr: "", code: 0 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${otherPnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      for (const [manager, command] of [
        ["pnpm", "npm"],
        [{ manager: "npm", command: customNpm }, customNpm],
      ] as const) {
        await expect(
          resolveGlobalInstallTarget({
            manager,
            runCommand,
            timeoutMs: 1000,
            pkgRoot,
            honorPackageRoot: true,
          }),
        ).resolves.toEqual({
          manager: "npm",
          command,
          globalRoot: managedNpmRoot,
          packageRoot: pkgRoot,
          directNodeModulesRoot: true,
          npmOwner: { version: "12.0.0", lifecyclePolicy: "allow-scripts" },
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
  });

  it.each([
    ["the running package root", false],
    ["virtual-store package roots", true],
  ] as const)("detects custom pnpm global layouts from %s", async (_name, virtualStore) => {
    const prefix = virtualStore
      ? "openclaw-update-pnpm-virtual-root-"
      : "openclaw-update-pnpm-custom-root-";
    await withTestDir({ prefix }, async (base) => {
      const customGlobalDir = path.join(base, "custom-pnpm");
      const customGlobalRoot = path.join(customGlobalDir, "5", "node_modules");
      const packageRoot = path.join(customGlobalRoot, "openclaw");
      const pkgRoot = virtualStore
        ? path.join(
            customGlobalDir,
            "5",
            ".pnpm",
            "openclaw@file+..+pack+openclaw-2026.5.6.tgz",
            "node_modules",
            "openclaw",
          )
        : packageRoot;
      const defaultPnpmRoot = path.join(base, "default-pnpm", "5", "node_modules");
      await fs.mkdir(customGlobalRoot, { recursive: true });
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(customGlobalDir, "5", "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(customGlobalRoot, ".modules.yaml"),
        "layoutVersion: 5\n",
        "utf8",
      );

      const runCommand: CommandRunner = async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (argv[0] === "pnpm") {
          return { stdout: `${defaultPnpmRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(
        resolveGlobalInstallTarget({
          ...(virtualStore
            ? { manager: "pnpm" as const }
            : {
                manager: { manager: "pnpm" as const, command: "/custom/bin/pnpm" },
                honorPackageRoot: true,
              }),
          runCommand,
          timeoutMs: 1000,
          pkgRoot,
        }),
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
  });

  it("builds global install argv for each supported manager", () => {
    expect(globalInstallArgs("npm", "openclaw@latest")).toEqual([
      "npm",
      "i",
      "-g",
      "--allow-scripts=openclaw",
      "openclaw@latest",
      "--no-fund",
      "--no-audit",
      "--loglevel=error",
      "--min-release-age=0",
    ]);
    for (const spec of ["openclaw@latest", "github:openclaw/openclaw#release/2026.5.12"]) {
      expect(globalInstallArgs("pnpm", spec)).toEqual([
        "pnpm",
        "add",
        "-g",
        "--allow-build=openclaw",
        spec,
      ]);
    }
    for (const [spec, expected] of [
      ["openclaw@latest", "openclaw@latest"],
      ["/tmp/openclaw-current.tgz", "openclaw@file:/tmp/openclaw-current.tgz"],
      ["https://example.test/openclaw.tgz", "openclaw@https://example.test/openclaw.tgz"],
      ["github:openclaw/openclaw#main", "openclaw@github:openclaw/openclaw#main"],
    ] as const) {
      expect(globalInstallArgs("bun", spec)).toEqual([
        process.versions.bun ? process.execPath : "bun",
        "add",
        "-g",
        "--trust",
        expected,
      ]);
    }
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

  it("cleans only renamed package directories", async () => {
    await withTestDir({ prefix: "openclaw-update-cleanup-" }, async (root) => {
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
      const packageDirStat = await fs.stat(path.join(root, "openclaw"));
      const markerFileStat = await fs.stat(path.join(root, ".openclaw-file"));
      expect(packageDirStat.isDirectory()).toBe(true);
      expect(markerFileStat.isFile()).toBe(true);
    });
  });

  it("checks installed dist against the packaged inventory", async () => {
    await withTestDir({ prefix: "openclaw-update-global-pkg-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);
      for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
        const absolutePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "export {};\n", "utf-8");
      }
      await writePackageDistInventory(packageRoot);

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toStrictEqual([]);

      await fs.rm(path.join(packageRoot, TELEGRAM_RUNTIME_API));
      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `missing packaged dist file ${TELEGRAM_RUNTIME_API}`,
      );

      const stale =
        "dist/extensions/telegram/.openclaw-install-stage/node_modules/typebox/code.mjs";
      await fs.mkdir(path.dirname(path.join(packageRoot, stale)), { recursive: true });
      await fs.writeFile(path.join(packageRoot, stale), "export {};\n", "utf8");
      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `unexpected packaged dist file ${stale}`,
      );
    });
  });

  it("flags global package roots that resolve into source checkouts", async () => {
    await withTestDir({ prefix: "openclaw-update-global-source-checkout-" }, async (base) => {
      const checkoutRoot = path.join(base, "checkout");
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await fs.mkdir(path.join(checkoutRoot, ".git"), { recursive: true });
      await fs.mkdir(path.join(checkoutRoot, "src"), { recursive: true });
      await fs.mkdir(path.join(checkoutRoot, "extensions"), { recursive: true });
      await fs.writeFile(path.join(checkoutRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
      await writeGlobalPackageJson(checkoutRoot, "2026.4.27");
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.symlink(checkoutRoot, packageRoot, "dir");
      const realCheckoutRoot = await fs.realpath(checkoutRoot);

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `global package root resolves to source checkout: ${realCheckoutRoot}`,
      );
    });
  });

  it("fails closed on newer installs when the inventory is missing", async () => {
    await withTestDir(
      { prefix: "openclaw-update-global-missing-inventory-new-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `missing package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
        );
      },
    );
  });

  it("rejects invalid inventory files during global verify", async () => {
    await withTestDir(
      { prefix: "openclaw-update-global-invalid-inventory-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH),
          "{not-json}\n",
          "utf8",
        );

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `invalid package dist inventory ${PACKAGE_DIST_INVENTORY_RELATIVE_PATH}`,
        );
      },
    );
  });

  it("verifies legacy sidecars for installed bundled plugins without inventory", async () => {
    await withTestDir({ prefix: "openclaw-update-global-legacy-plugin-" }, async (packageRoot) => {
      await writeGlobalPackageJson(packageRoot);
      await writeBundledPluginPackageJson(packageRoot, "telegram", "@openclaw/telegram");

      await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
        `missing bundled runtime sidecar ${TELEGRAM_RUNTIME_API}`,
      );
    });
  });

  it("still enforces critical sidecars when the inventory omits them", async () => {
    await withTestDir(
      { prefix: "openclaw-update-global-critical-sidecars-" },
      async (packageRoot) => {
        await writeGlobalPackageJson(packageRoot, "2026.4.15");
        await writeBundledPluginPackageJson(packageRoot, "telegram", "@openclaw/telegram");
        await writePackageDistInventory(packageRoot);

        await expect(collectInstalledGlobalPackageErrors({ packageRoot })).resolves.toContain(
          `missing bundled runtime sidecar ${TELEGRAM_RUNTIME_API}`,
        );
      },
    );
  });
});
