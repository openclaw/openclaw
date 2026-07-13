// Exercises npm-managed root detection across package-manager markers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { CommandOptions } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import {
  readOpenClawManagedNpmRootOverrides,
  syncManagedNpmRootPeerDependencies,
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

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const statError = error as NodeJS.ErrnoException;
    expect({
      code: statError.code,
      path: statError.path,
      syscall: statError.syscall,
    }).toEqual({
      code: "ENOENT",
      path: targetPath,
      syscall: "lstat",
    });
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function requireFirstMockCall<T extends unknown[]>(
  mock: { mock: { calls: T[] } },
  label: string,
): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

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
  it("reads workspace pnpm overrides for managed plugin installs", async () => {
    const workspace = YAML.parse(
      await fs.readFile(path.resolve(process.cwd(), "pnpm-workspace.yaml"), "utf8"),
    ) as { overrides?: Record<string, unknown> };
    const expectedOverrides = workspace.overrides ?? {};

    expect(expectedOverrides).toMatchObject({
      axios: "1.16.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });
    await expect(readOpenClawManagedNpmRootOverrides()).resolves.toEqual(expectedOverrides);
  });

  it("resolves workspace pnpm overrides from packaged dist chunks", async () => {
    const packageRoot = await makeTempRoot();
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "openclaw",
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(packageRoot, "pnpm-workspace.yaml"),
      "overrides:\n  axios: 1.16.0\n",
    );

    await expect(
      readOpenClawManagedNpmRootOverrides({
        moduleUrl: pathToFileURL(path.join(packageRoot, "dist", "install-AbCdEf.js")).toString(),
        cwd: path.join(packageRoot, "dist"),
      }),
    ).resolves.toEqual({
      axios: "1.16.0",
    });
  });

  it("resolves npm override dependency references from the host package manifest", async () => {
    const packageRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "openclaw",
          dependencies: {
            "managed-runtime": "3.1024.0",
            "node-domexception": "npm:@nolyfill/domexception@1.0.28",
          },
          optionalDependencies: {
            "optional-runtime": "2.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(packageRoot, "pnpm-workspace.yaml"),
      [
        "overrides:",
        '  managed-runtime: "$managed-runtime"',
        "  nested:",
        '    optional-runtime: "$optional-runtime"',
        '    alias: "$node-domexception"',
        "  axios: 1.16.0",
        '  node-domexception: "$node-domexception"',
        "",
      ].join("\n"),
    );

    await expect(readOpenClawManagedNpmRootOverrides({ packageRoot })).resolves.toEqual({
      "managed-runtime": "3.1024.0",
      nested: {
        "optional-runtime": "2.0.0",
        alias: "npm:@nolyfill/domexception@1.0.28",
      },
      axios: "1.16.0",
      "node-domexception": "npm:@nolyfill/domexception@1.0.28",
    });
  });

  it("syncs managed peer dependencies from npm's resolved lockfile plan", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
    );

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
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      );
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);

    const [args, rawOptions] = requireFirstMockCall(runCommand, "npm peer plan command");
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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
    );

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
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      );
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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "aliased-peer": "3.0.10",
            plugin: "1.0.0",
            "runtime-peer": "4.12.23",
          },
          openclaw: {
            managedPeerDependencies: ["aliased-peer", "runtime-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );

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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
            "runtime-peer": "2.0.0",
          },
          openclaw: {
            managedPeerDependencies: ["runtime-peer"],
          },
        },
        null,
        2,
      )}\n`,
    );

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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

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
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      );
      return successfulSpawn;
    });

    await expect(syncManagedNpmRootPeerDependencies({ npmRoot, runCommand })).resolves.toBe(true);
    expect(runCommand).toHaveBeenCalledTimes(2);
    const [strictArgs, rawStrictOptions] = runCommand.mock.calls[0] ?? [];
    const [fallbackArgs, rawFallbackOptions] = runCommand.mock.calls[1] ?? [];
    const strictOptions = requireCommandOptions(rawStrictOptions, "strict npm peer plan");
    const fallbackOptions = requireCommandOptions(rawFallbackOptions, "fallback npm peer plan");
    expect(strictArgs).not.toContain("--legacy-peer-deps");
    expect(strictOptions.env?.npm_config_legacy_peer_deps).toBe("false");
    expect(fallbackArgs).toContain("--legacy-peer-deps");
    expect(fallbackOptions.env?.npm_config_legacy_peer_deps).toBe("true");
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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      );
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
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            plugin: "file:./plugin.tgz",
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn(async (_args: string[], optionsOrTimeout: number | CommandOptions) => {
      const options = requireCommandOptions(optionsOrTimeout, "npm peer plan");
      if (!options.cwd) {
        throw new Error("expected npm peer plan cwd");
      }
      await fs.writeFile(
        path.join(options.cwd, "package-lock.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2,
        )}\n`,
      );
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
