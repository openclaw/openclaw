// Exercises npm-managed root detection across package-manager markers.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  listMissingRequiredPlatformPackages,
  readManagedNpmRootInstalledDependency,
  readOpenClawManagedNpmRootOverrides,
  resolveManagedNpmRootDependencySpec,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
} from "./npm-managed-root.js";

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-npm-managed-root-",
});
const tempDirs: string[] = [];
let npmConfigEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

const successfulSpawn = {
  code: 0,
  stdout: "",
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit" as const,
};

async function writeFixtureJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeTempRoot(): Promise<string> {
  const dir = await fixtureRootTracker.make("case");
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const fixtureRoot = await fixtureRootTracker.setup();
  npmConfigEnvSnapshot = captureEnv(["NPM_CONFIG_GLOBALCONFIG"]);
  const globalConfig = path.join(fixtureRoot, "global-npmrc");
  await fs.writeFile(globalConfig, "", "utf8");
  process.env.NPM_CONFIG_GLOBALCONFIG = globalConfig;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  npmConfigEnvSnapshot?.restore();
  npmConfigEnvSnapshot = undefined;
  await fixtureRootTracker.cleanup();
});

function requireCommandOptions(
  options: number | CommandOptions | undefined,
  label: string,
): CommandOptions {
  if (!options || typeof options === "number") {
    throw new Error(`expected ${label} command options`);
  }
  return options;
}

describe("managed npm root", () => {
  it("finds explicitly required optional packages for the current platform", async () => {
    const npmRoot = await makeTempRoot();
    const matchingPackage = "@vendor/tool-platform";
    const scriptedPackage = "@vendor/tool-scripted";
    const foreignPackage = "@vendor/tool-foreign";
    const unconstrainedPackage = "@vendor/tool-optional";
    const unlistedPackage = "@vendor/tool-unlisted";
    await writeFixtureJson(path.join(npmRoot, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": {},
        [`node_modules/${matchingPackage}`]: {
          optional: true,
          os: [process.platform],
          cpu: [process.arch],
        },
        [`node_modules/${scriptedPackage}`]: {
          optional: true,
          hasInstallScript: true,
          os: [process.platform],
          cpu: [process.arch],
        },
        [`node_modules/${foreignPackage}`]: {
          optional: true,
          os: [`not-${process.platform}`],
          cpu: [process.arch],
        },
        [`node_modules/${unconstrainedPackage}`]: {
          optional: true,
        },
        [`node_modules/${unlistedPackage}`]: {
          optional: true,
          os: [process.platform],
          cpu: [process.arch],
        },
      },
    });

    await expect(
      listMissingRequiredPlatformPackages({
        npmRoot,
        requiredPackageNames: [
          matchingPackage,
          scriptedPackage,
          foreignPackage,
          unconstrainedPackage,
        ],
      }),
    ).resolves.toEqual(
      [matchingPackage, scriptedPackage]
        .map((name) => ({
          name,
          packagePath: path.join(npmRoot, "node_modules", ...name.split("/")),
        }))
        .toSorted((left, right) => left.packagePath.localeCompare(right.packagePath)),
    );
  });

  it.each([
    { installedState: "missing package manifest", expectedMissing: true },
    { installedState: "invalid package manifest", expectedMissing: true },
    { installedState: "missing native executable", expectedMissing: true },
    {
      installedState: "non-executable native executable",
      expectedMissing: process.platform !== "win32",
    },
    { installedState: "installed native executable", expectedMissing: false },
  ])(
    "validates current-platform package contents: $installedState",
    async ({ installedState, expectedMissing }) => {
      const npmRoot = await makeTempRoot();
      const platformPackage = "@vendor/tool-platform";
      const canonicalPackage = "@vendor/tool";
      const packagePath = path.join(npmRoot, "node_modules", ...platformPackage.split("/"));
      await fs.mkdir(packagePath, { recursive: true });
      await writeFixtureJson(path.join(npmRoot, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {},
          [`node_modules/${canonicalPackage}`]: {
            bin: { tool: "bin/tool.js" },
          },
          [`node_modules/${platformPackage}`]: {
            name: canonicalPackage,
            optional: true,
            os: [process.platform],
            cpu: [process.arch],
          },
        },
      });

      if (installedState === "invalid package manifest") {
        await fs.writeFile(path.join(packagePath, "package.json"), "{", "utf8");
      } else if (installedState !== "missing package manifest") {
        await writeFixtureJson(path.join(packagePath, "package.json"), {
          name: canonicalPackage,
          version: "1.0.0-platform",
          files: ["vendor"],
        });
        const nativeBinDir = path.join(packagePath, "vendor", "current-platform", "bin");
        await fs.mkdir(nativeBinDir, { recursive: true });
        await fs.writeFile(path.join(nativeBinDir, "tool-helper"), "helper", "utf8");
        if (
          installedState === "installed native executable" ||
          installedState === "non-executable native executable"
        ) {
          const executableName = process.platform === "win32" ? "tool.exe" : "tool";
          await fs.writeFile(path.join(nativeBinDir, executableName), "native executable", {
            encoding: "utf8",
            mode: installedState === "installed native executable" ? 0o755 : 0o644,
          });
        }
      }

      await expect(
        listMissingRequiredPlatformPackages({
          npmRoot,
          requiredPackageNames: [platformPackage],
        }),
      ).resolves.toEqual(expectedMissing ? [{ name: platformPackage, packagePath }] : []);
    },
  );

  it("keeps existing plugin dependencies when adding another managed plugin", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.2",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("syncs OpenClaw-owned overrides without dropping unrelated local overrides", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
      },
      overrides: {
        axios: "1.13.6",
        "left-pad": "1.3.0",
        qs: "6.14.0",
      },
      openclaw: {
        managedOverrides: ["axios", "qs"],
      },
    });

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.4",
      managedOverrides: {
        axios: "1.18.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          semver: "1.2.3",
          alias: "npm:@scope/alias@1.0.0",
        },
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.4",
      },
      overrides: {
        "left-pad": "1.3.0",
        axios: "1.18.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          alias: "npm:@scope/alias@1.0.0",
          semver: "1.2.3",
        },
      },
      openclaw: {
        managedOverrides: ["axios", "nested", "node-domexception"],
      },
    });
  });

  it("can omit npm alias overrides for npm versions that reject them", async () => {
    const npmRoot = await makeTempRoot();

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.4",
      omitNpmAliasOverrides: true,
      managedOverrides: {
        axios: "1.18.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
        nested: {
          alias: "npm:@scope/alias@1.0.0",
          semver: "1.2.3",
        },
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      overrides: {
        axios: "1.18.0",
        nested: {
          semver: "1.2.3",
        },
      },
      openclaw: {
        managedOverrides: ["axios", "nested"],
      },
    });
  });

  it("aligns stale managed peer pins with managed overrides when adding a plugin", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "4.12.23",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "plugin",
      dependencySpec: "2.0.0",
      managedOverrides: {
        "runtime-peer": "4.12.18",
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "2.0.0",
        "runtime-peer": "4.12.18",
      },
      overrides: {
        "runtime-peer": "4.12.18",
      },
      openclaw: {
        managedOverrides: ["runtime-peer"],
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("drops managed overrides that conflict with an explicitly installed package", async () => {
    const npmRoot = await makeTempRoot();

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "pinned-package",
      dependencySpec: "2.0.0",
      managedOverrides: {
        "pinned-package": "1.0.0",
        axios: "1.18.0",
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "pinned-package": "2.0.0",
      },
      overrides: {
        axios: "1.18.0",
      },
      openclaw: {
        managedOverrides: ["axios"],
      },
    });
  });

  it("keeps child override rules when only the root entry conflicts with an installed package", async () => {
    const npmRoot = await makeTempRoot();

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "pinned-package",
      dependencySpec: "2.0.0",
      managedOverrides: {
        "pinned-package": { ".": "1.0.0", "vuln-child": "3.0.0" },
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "pinned-package": "2.0.0",
      },
      overrides: {
        "pinned-package": { "vuln-child": "3.0.0" },
      },
      openclaw: {
        managedOverrides: ["pinned-package"],
      },
    });
  });

  it("does not treat wildcard overrides as root dependency conflicts", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "4.12.23",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "plugin",
      dependencySpec: "2.0.0",
      managedOverrides: {
        "runtime-peer": "*",
      },
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      dependencies: {
        plugin: "2.0.0",
        "runtime-peer": "4.12.23",
      },
      overrides: {
        "runtime-peer": "*",
      },
    });
  });

  it("transfers ownership of a managed peer pin when it is explicitly installed", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "4.12.23",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "runtime-peer",
      dependencySpec: "5.0.0",
    });

    // The installed package leaves managedPeerDependencies so the next peer sync
    // cannot re-pin or delete the explicitly requested version.
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "5.0.0",
      },
    });
  });

  it("resolves workspace pnpm overrides from packaged dist chunks", async () => {
    const packageRoot = await makeTempRoot();
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFixtureJson(path.join(packageRoot, "package.json"), {
      name: "openclaw",
    });
    await fs.writeFile(
      path.join(packageRoot, "pnpm-workspace.yaml"),
      "overrides:\n  axios: 1.18.0\n",
    );

    await expect(
      readOpenClawManagedNpmRootOverrides({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "install-AbCdEf.js")).toString(),
        cwd: path.join(packageRoot, "dist"),
      }),
    ).resolves.toEqual({
      axios: "1.18.0",
    });
  });

  it("normalizes workspace overrides before managed npm use", async () => {
    const packageRoot = await makeTempRoot();
    await writeFixtureJson(path.join(packageRoot, "package.json"), {
      name: "openclaw",
      dependencies: {
        "managed-runtime": "3.1024.0",
        "node-domexception": "npm:@nolyfill/domexception@1.0.28",
      },
      optionalDependencies: {
        "optional-runtime": "2.0.0",
      },
    });
    await fs.writeFile(
      path.join(packageRoot, "pnpm-workspace.yaml"),
      [
        "overrides:",
        '  "parent@1>child": 2.0.0',
        '  "parent>@scope/child": 2.0.0',
        '  "@scope/parent@1>@scope/child": 2.0.0',
        '  "range-target@>1": 2.0.0',
        '  managed-runtime: "$managed-runtime"',
        "  nested:",
        '    "parent>child": 2.0.0',
        '    "range-target@>=1": 2.0.0',
        '    ".": 1.0.0',
        '    optional-runtime: "$optional-runtime"',
        '    alias: "$node-domexception"',
        "  axios: 1.18.0",
        '  node-domexception: "$node-domexception"',
        "",
      ].join("\n"),
    );

    await expect(readOpenClawManagedNpmRootOverrides({ packageRoot })).resolves.toEqual({
      "range-target@>1": "2.0.0",
      "managed-runtime": "3.1024.0",
      nested: {
        "range-target@>=1": "2.0.0",
        ".": "1.0.0",
        "optional-runtime": "2.0.0",
        alias: "npm:@nolyfill/domexception@1.0.28",
      },
      axios: "1.18.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });
  });

  it("does not overwrite a present malformed package manifest", async () => {
    const npmRoot = await makeTempRoot();
    const manifestPath = path.join(npmRoot, "package.json");
    await fs.writeFile(manifestPath, "{not-json", "utf8");

    await expect(
      upsertManagedNpmRootDependency({
        npmRoot,
        packageName: "@openclaw/feishu",
        dependencySpec: "2026.5.2",
      }),
    ).rejects.toThrow(/JSON|package\.json|not-json/i);

    await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe("{not-json");
  });

  it("pins managed dependencies to the resolved version", () => {
    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord@stable",
          selector: "stable",
          selectorKind: "tag",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");

    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord",
          selectorKind: "none",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");
  });

  it("reads installed dependency metadata from package-lock", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "node_modules/@openclaw/discord": {
          version: "2026.5.2",
          resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
          integrity: "sha512-discord",
        },
      },
    });

    await expect(
      readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: "@openclaw/discord",
      }),
    ).resolves.toEqual({
      version: "2026.5.2",
      resolved: "https://registry.npmjs.org/@openclaw/discord/-/discord-2026.5.2.tgz",
      integrity: "sha512-discord",
    });
  });

  it.each([
    { name: "default", timeoutMs: undefined, workTimeoutMs: undefined, expectedTimeoutMs: 300_000 },
    {
      name: "unbounded update",
      timeoutMs: 120_000,
      workTimeoutMs: null,
      expectedTimeoutMs: undefined,
    },
    { name: "explicit update", timeoutMs: 120_000, workTimeoutMs: 50, expectedTimeoutMs: 50 },
    { name: "short explicit", timeoutMs: 45_000, expectedTimeoutMs: 45_000 },
    { name: "long explicit", timeoutMs: 420_000, expectedTimeoutMs: 420_000 },
  ])("syncs managed peer pins with the $name budget", async (testCase) => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        "existing-root": "1.0.0",
        "old-peer": "1.0.0",
        plugin: "1.0.0",
      },
      devDependencies: {
        "dev-plugin": "1.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["old-peer"],
      },
    });

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      const tempManifest = JSON.parse(
        await fs.readFile(path.join(options.cwd, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      expect(tempManifest.dependencies).toEqual({
        "existing-root": "1.0.0",
        plugin: "1.0.0",
      });
      await writeFixtureJson(path.join(options.cwd, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: tempManifest.dependencies,
          },
          "node_modules/existing-root": {
            version: "1.0.0",
          },
          "node_modules/dev-peer": {
            dev: true,
            version: "3.0.0",
          },
          "node_modules/dev-plugin": {
            dev: true,
            peerDependencies: {
              "dev-peer": "^3.0.0",
            },
            version: "1.0.0",
          },
          "node_modules/new-peer": {
            peer: true,
            version: "2.1.0",
          },
          "node_modules/openclaw": {
            peer: true,
            version: "2026.5.12",
          },
          "node_modules/plugin": {
            peerDependencies: {
              "existing-root": "^1.0.0",
              "new-peer": "^2.0.0",
              openclaw: ">=2026.5.0",
            },
            version: "1.0.0",
          },
          "node_modules/unsupported-optional": {
            optional: true,
            os: [process.platform === "win32" ? "darwin" : "win32"],
            peerDependencies: {
              "unsupported-peer": "^9.0.0",
            },
            version: "1.0.0",
          },
        },
      });
      return successfulSpawn;
    });

    await expect(
      syncManagedNpmRootPeerDependencies({
        npmRoot,
        runCommand,
        timeoutMs: testCase.timeoutMs,
        workTimeoutMs: testCase.workTimeoutMs,
      }),
    ).resolves.toBe(true);

    const [args, rawOptions] = expectDefined(
      runCommand.mock.calls[0],
      "npm peer plan command call",
    );
    const options = requireCommandOptions(rawOptions, "npm peer plan");
    expect(args).toEqual([
      "npm",
      "install",
      "--package-lock-only",
      "--force",
      "--omit=dev",
      "--omit=peer",
      "--loglevel=error",
      "--ignore-scripts",
      "--workspaces=false",
      "--no-audit",
      "--no-fund",
    ]);
    expect(options?.cwd).not.toBe(npmRoot);
    expect(options.timeoutMs).toBe(testCase.expectedTimeoutMs);
    expect(options?.env?.npm_config_legacy_peer_deps).toBe("false");

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "existing-root": "1.0.0",
        "new-peer": "2.1.0",
        plugin: "1.0.0",
      },
      devDependencies: {
        "dev-plugin": "1.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["new-peer"],
      },
    });
  });

  it("advances stale managed peer pins to the override-aware npm plan", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "4.12.23",
      },
      overrides: {
        "runtime-peer": "4.12.18",
      },
      openclaw: {
        managedOverrides: ["runtime-peer"],
        managedPeerDependencies: ["runtime-peer"],
      },
    });

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      const tempManifest = JSON.parse(
        await fs.readFile(path.join(options.cwd, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        overrides?: Record<string, string>;
      };
      expect(tempManifest.dependencies).toEqual({ plugin: "1.0.0" });
      expect(tempManifest.overrides).toEqual({ "runtime-peer": "4.12.18" });
      await writeFixtureJson(path.join(options.cwd, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: tempManifest.dependencies,
          },
          "node_modules/plugin": {
            peerDependencies: {
              "runtime-peer": "^4.0.0",
            },
            version: "1.0.0",
          },
          "node_modules/runtime-peer": {
            peer: true,
            version: "4.12.18",
          },
        },
      });
      return successfulSpawn;
    });

    await expect(
      syncManagedNpmRootPeerDependencies({
        npmRoot,
        managedOverrides: { "runtime-peer": "4.12.18" },
        runCommand,
      }),
    ).resolves.toBe(true);

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "4.12.18",
      },
      overrides: {
        "runtime-peer": "4.12.18",
      },
      openclaw: {
        managedOverrides: ["runtime-peer"],
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("reconciles preserved stale pins with managed overrides when peer planning fails", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        "aliased-peer": "3.0.10",
        plugin: "1.0.0",
        "runtime-peer": "4.12.23",
      },
      openclaw: {
        managedPeerDependencies: ["aliased-peer", "runtime-peer"],
      },
    });

    const runCommand = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "npm ERR! network request failed",
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));

    await expect(
      syncManagedNpmRootPeerDependencies({
        npmRoot,
        managedOverrides: {
          "aliased-peer": "npm:@scope/real@3.0.10",
          "runtime-peer": "4.12.18",
        },
        runCommand,
      }),
    ).resolves.toBe(true);

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "aliased-peer": "npm:@scope/real@3.0.10",
        plugin: "1.0.0",
        "runtime-peer": "4.12.18",
      },
      overrides: {
        "aliased-peer": "npm:@scope/real@3.0.10",
        "runtime-peer": "4.12.18",
      },
      openclaw: {
        managedOverrides: ["aliased-peer", "runtime-peer"],
        managedPeerDependencies: ["aliased-peer", "runtime-peer"],
      },
    });
  });

  it("preserves existing managed peer dependencies when npm cannot plan third-party peers", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });

    const runCommand = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "npm ERR! ERESOLVE could not resolve third-party peer dependency",
      signal: null,
      killed: false,
      termination: "exit" as const,
    }));

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(1);
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("uses lockfile metadata to preserve non-host peers when host peer planning fails", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
      },
    });

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      if (runCommand.mock.calls.length === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "npm ERR! notarget No matching version found for openclaw@2026.5.99-beta.1",
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      await writeFixtureJson(path.join(options.cwd, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              plugin: "1.0.0",
            },
          },
          "node_modules/plugin": {
            peerDependencies: {
              openclaw: "2026.5.99-beta.1",
              "runtime-peer": "^2.0.0",
            },
            version: "1.0.0",
          },
        },
      });
      return successfulSpawn;
    });

    await expect(
      syncManagedNpmRootPeerDependencies({ npmRoot, runCommand, timeoutMs: 45_000 }),
    ).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
    const [strictArgs, rawStrictOptions] = runCommand.mock.calls[0] ?? [];
    const [fallbackArgs, rawFallbackOptions] = runCommand.mock.calls[1] ?? [];
    const strictOptions = requireCommandOptions(rawStrictOptions, "strict npm peer plan");
    const fallbackOptions = requireCommandOptions(rawFallbackOptions, "fallback npm peer plan");
    expect(strictArgs).not.toContain("--legacy-peer-deps");
    expect(strictOptions.env?.npm_config_legacy_peer_deps).toBe("false");
    expect(fallbackArgs).toContain("--legacy-peer-deps");
    expect(fallbackOptions.env?.npm_config_legacy_peer_deps).toBe("true");
    expect([strictOptions.timeoutMs, fallbackOptions.timeoutMs]).toEqual([45_000, 45_000]);
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "^2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("does not promote nested transitive lockfile versions into managed root peers", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "1.0.0",
      },
    });

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      await writeFixtureJson(path.join(options.cwd, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              plugin: "1.0.0",
            },
          },
          "node_modules/plugin": {
            peerDependencies: {
              "runtime-peer": "^2.0.0",
            },
            version: "1.0.0",
          },
          "node_modules/transitive": {
            version: "1.0.0",
          },
          "node_modules/transitive/node_modules/runtime-peer": {
            version: "1.0.0",
          },
        },
      });
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "1.0.0",
        "runtime-peer": "^2.0.0",
      },
      openclaw: {
        managedPeerDependencies: ["runtime-peer"],
      },
    });
  });

  it("does not promote nested bundled peer ranges without a root peer package", async () => {
    const npmRoot = await makeTempRoot();
    await writeFixtureJson(path.join(npmRoot, "package.json"), {
      private: true,
      dependencies: {
        plugin: "file:./plugin.tgz",
      },
    });

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      await writeFixtureJson(path.join(options.cwd, "package-lock.json"), {
        lockfileVersion: 3,
        packages: {
          "": {
            dependencies: {
              plugin: "file:./plugin.tgz",
            },
          },
          "node_modules/plugin": {
            version: "1.0.0",
          },
          "node_modules/plugin/node_modules/runtime-lib": {
            peerDependencies: {
              zod: "^4.0.0",
            },
            version: "1.0.0",
          },
          "node_modules/plugin/node_modules/zod": {
            version: "4.4.3",
          },
        },
      });
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(false);

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        plugin: "file:./plugin.tgz",
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
