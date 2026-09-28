// Covers managed peer repair without changing active host ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { repairManagedNpmRootOpenClawPeer } from "./npm-managed-root.js";

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

function requireCommandOptions(
  options: number | CommandOptions | undefined,
  label: string,
): CommandOptions {
  if (!options || typeof options === "number") {
    throw new Error(`expected ${label} command options`);
  }
  return options;
}

describe("managed npm root peer repair", () => {
  it.each([
    { workTimeoutMs: undefined, expectedTimeoutMs: 300_000 },
    { workTimeoutMs: null, expectedTimeoutMs: undefined },
    { workTimeoutMs: 50, expectedTimeoutMs: 50 },
  ])(
    "repairs stale managed peer state with work deadline $workTimeoutMs",
    async ({ workTimeoutMs, expectedTimeoutMs }) => {
      const npmRoot = await makeTempRoot();
      await fs.mkdir(path.join(npmRoot, "node_modules", "openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(npmRoot, "package.json"),
        `${JSON.stringify(
          {
            private: true,
            dependencies: {
              openclaw: "2026.5.4",
              "@openclaw/discord": "2026.5.4",
            },
          },
          null,
          2,
        )}\n`,
      );
      await fs.writeFile(
        path.join(npmRoot, "package-lock.json"),
        `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  openclaw: "2026.5.4",
                  "@openclaw/discord": "2026.5.4",
                },
              },
              "node_modules/openclaw": {
                version: "2026.5.4",
              },
              "node_modules/@openclaw/discord": {
                version: "2026.5.4",
              },
            },
            dependencies: {
              openclaw: {
                version: "2026.5.4",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      await fs.writeFile(
        path.join(npmRoot, "node_modules", "openclaw", "package.json"),
        `${JSON.stringify({ name: "openclaw", version: "2026.5.4" })}\n`,
      );
      await fs.mkdir(path.join(npmRoot, "node_modules", ".bin"), { recursive: true });
      await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw"), "shim");
      await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.cmd"), "cmd shim");
      await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.ps1"), "ps1 shim");
      await fs.writeFile(
        path.join(npmRoot, "node_modules", ".package-lock.json"),
        `${JSON.stringify(
          {
            lockfileVersion: 3,
            packages: {
              "node_modules/openclaw": {
                version: "2026.5.4",
              },
            },
          },
          null,
          2,
        )}\n`,
      );

      const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
      await expect(
        repairManagedNpmRootOpenClawPeer({ npmRoot, runCommand, workTimeoutMs }),
      ).resolves.toBe(true);
      expect(runCommand).toHaveBeenCalledTimes(1);
      const [repairArgs, rawRepairOptions] = expectDefined(
        runCommand.mock.calls[0],
        "repair command call",
      );
      const repairOptions = requireCommandOptions(rawRepairOptions, "repair");
      expect(repairArgs).toEqual([
        "npm",
        "uninstall",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "openclaw",
      ]);
      expect(repairOptions?.cwd).toBe(npmRoot);
      expect(repairOptions?.timeoutMs).toBe(expectedTimeoutMs);
      expect(repairOptions?.env?.npm_config_legacy_peer_deps).toBe("true");

      const manifest = JSON.parse(
        await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies).toEqual({
        "@openclaw/discord": "2026.5.4",
      });
      const lockfile = JSON.parse(
        await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
      ) as {
        packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
        dependencies?: Record<string, unknown>;
      };
      expect(lockfile.packages?.[""]?.dependencies).toEqual({
        "@openclaw/discord": "2026.5.4",
      });
      expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
      expect(lockfile.packages?.["node_modules/@openclaw/discord"]?.version).toBe("2026.5.4");
      expect(lockfile.dependencies?.openclaw).toBeUndefined();
      await expectPathMissing(path.join(npmRoot, "node_modules", "openclaw"));
      for (const binName of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
        await expectPathMissing(path.join(npmRoot, "node_modules", ".bin", binName));
      }
      await expectPathMissing(path.join(npmRoot, "node_modules", ".package-lock.json"));
    },
  );

  it("does not repair the active OpenClaw host package in a root-managed install", async () => {
    const npmRoot = await makeTempRoot();
    const hostPackageRoot = path.join(npmRoot, "node_modules", "openclaw");
    await fs.mkdir(path.join(hostPackageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            openclaw: "2026.5.12-beta.6",
            "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                openclaw: "2026.5.12-beta.6",
                "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
              },
            },
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(hostPackageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.5.12-beta.6" })}\n`,
    );

    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({
        npmRoot,
        packageRoot: hostPackageRoot,
        runCommand,
      }),
    ).resolves.toBe(false);

    expect(runCommand).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toMatchObject({
      dependencies: {
        openclaw: "2026.5.12-beta.6",
        "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
      },
    });
    await expect(
      fs.readFile(path.join(hostPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain("2026.5.12-beta.6");
  });

  it("scrubs managed ownership metadata without deleting a linked active host package", async () => {
    const npmRoot = await makeTempRoot();
    const hostPackageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-host-package-"));
    tempDirs.push(hostPackageRoot);
    await fs.mkdir(path.join(npmRoot, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(
      path.join(hostPackageRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw", version: "2026.5.12-beta.6" })}\n`,
    );
    await fs.symlink(hostPackageRoot, path.join(npmRoot, "node_modules", "openclaw"), "dir");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw"), "shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.cmd"), "cmd shim");
    await fs.writeFile(path.join(npmRoot, "node_modules", ".bin", "openclaw.ps1"), "ps1 shim");
    await fs.writeFile(
      path.join(npmRoot, "node_modules", ".package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            openclaw: "2026.5.12-beta.6",
            "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fs.writeFile(
      path.join(npmRoot, "package-lock.json"),
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": {
              dependencies: {
                openclaw: "2026.5.12-beta.6",
                "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
              },
            },
            "node_modules/openclaw": {
              version: "2026.5.12-beta.6",
            },
            "node_modules/@xdarkicex/openclaw-memory-libravdb": {
              version: "1.4.69",
            },
          },
          dependencies: {
            openclaw: {
              version: "2026.5.12-beta.6",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({
        npmRoot,
        packageRoot: hostPackageRoot,
        runCommand,
      }),
    ).resolves.toBe(true);

    expect(runCommand).not.toHaveBeenCalled();
    await expect(fs.realpath(path.join(npmRoot, "node_modules", "openclaw"))).resolves.toBe(
      await fs.realpath(hostPackageRoot),
    );
    await expect(
      fs.readFile(path.join(hostPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain("2026.5.12-beta.6");

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
    });

    const lockfile = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
      dependencies?: Record<string, unknown>;
    };
    expect(lockfile.packages?.[""]?.dependencies).toEqual({
      "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
    });
    expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
    expect(lockfile.packages?.["node_modules/@xdarkicex/openclaw-memory-libravdb"]?.version).toBe(
      "1.4.69",
    );
    expect(lockfile.dependencies?.openclaw).toBeUndefined();
    for (const binName of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
      await expectPathMissing(path.join(npmRoot, "node_modules", ".bin", binName));
    }
    await expectPathMissing(path.join(npmRoot, "node_modules", ".package-lock.json"));
  });
});
