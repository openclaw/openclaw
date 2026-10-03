import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { captureEnv } from "../test-utils/env.js";
import { expectedNpmCommand } from "../test-utils/npm-command.js";
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

async function writeFixtureJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeManagedPeerMetadata(
  npmRoot: string,
  version: string,
  peerName: string,
  peerVersion: string,
): Promise<void> {
  const dependencies = { openclaw: version, [peerName]: peerVersion };
  await writeFixtureJson(path.join(npmRoot, "package.json"), { private: true, dependencies });
  await writeFixtureJson(path.join(npmRoot, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies },
      "node_modules/openclaw": { version },
      [`node_modules/${peerName}`]: { version: peerVersion },
    },
    dependencies: { openclaw: { version } },
  });
}

async function writePeerShims(npmRoot: string, version: string): Promise<void> {
  const modules = path.join(npmRoot, "node_modules");
  await fs.mkdir(path.join(modules, ".bin"), { recursive: true });
  for (const [name, content] of Object.entries({
    openclaw: "shim",
    "openclaw.cmd": "cmd shim",
    "openclaw.ps1": "ps1 shim",
  })) {
    await fs.writeFile(path.join(modules, ".bin", name), content);
  }
  await writeFixtureJson(path.join(modules, ".package-lock.json"), {
    lockfileVersion: 3,
    packages: { "node_modules/openclaw": { version } },
  });
}

async function expectPeerMetadataRemoved(
  npmRoot: string,
  peerName: string,
  peerVersion: string,
): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(manifest.dependencies).toEqual({ [peerName]: peerVersion });
  const lockfile = JSON.parse(
    await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"),
  ) as {
    packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>;
    dependencies?: Record<string, unknown>;
  };
  expect(lockfile.packages?.[""]?.dependencies).toEqual({ [peerName]: peerVersion });
  expect(lockfile.packages?.["node_modules/openclaw"]).toBeUndefined();
  expect(lockfile.packages?.[`node_modules/${peerName}`]?.version).toBe(peerVersion);
  expect(lockfile.dependencies?.openclaw).toBeUndefined();
  for (const binName of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
    await expectPathMissing(path.join(npmRoot, "node_modules", ".bin", binName));
  }
  await expectPathMissing(path.join(npmRoot, "node_modules", ".package-lock.json"));
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
      await writeManagedPeerMetadata(npmRoot, "2026.5.4", "@openclaw/discord", "2026.5.4");
      await writeFixtureJson(path.join(npmRoot, "node_modules", "openclaw", "package.json"), {
        name: "openclaw",
        version: "2026.5.4",
      });
      await writePeerShims(npmRoot, "2026.5.4");

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
      expect(repairArgs).toEqual(
        expectedNpmCommand([
          "uninstall",
          "--loglevel=error",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "openclaw",
        ]),
      );
      expect(repairOptions.cwd).toBe(npmRoot);
      expect(repairOptions.timeoutMs).toBe(expectedTimeoutMs);
      expect(repairOptions.env?.npm_config_legacy_peer_deps).toBe("true");

      await expectPeerMetadataRemoved(npmRoot, "@openclaw/discord", "2026.5.4");
      await expectPathMissing(path.join(npmRoot, "node_modules", "openclaw"));
    },
  );

  it("does not repair the active OpenClaw host package in a root-managed install", async () => {
    const npmRoot = await makeTempRoot();
    const hostPackageRoot = path.join(npmRoot, "node_modules", "openclaw");
    await fs.mkdir(path.join(hostPackageRoot, "dist"), { recursive: true });
    const dependencies = {
      openclaw: "2026.5.12-beta.6",
      "@xdarkicex/openclaw-memory-libravdb": "1.4.69",
    };
    await writeFixtureJson(path.join(npmRoot, "package.json"), { private: true, dependencies });
    await writeFixtureJson(path.join(npmRoot, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": { dependencies },
        "node_modules/openclaw": { version: "2026.5.12-beta.6" },
      },
    });
    await writeFixtureJson(path.join(hostPackageRoot, "package.json"), {
      name: "openclaw",
      version: "2026.5.12-beta.6",
    });

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
    await writePeerShims(npmRoot, "2026.5.12-beta.6");
    await writeFixtureJson(path.join(hostPackageRoot, "package.json"), {
      name: "openclaw",
      version: "2026.5.12-beta.6",
    });
    await fs.symlink(hostPackageRoot, path.join(npmRoot, "node_modules", "openclaw"), "dir");
    await writeManagedPeerMetadata(
      npmRoot,
      "2026.5.12-beta.6",
      "@xdarkicex/openclaw-memory-libravdb",
      "1.4.69",
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

    await expectPeerMetadataRemoved(npmRoot, "@xdarkicex/openclaw-memory-libravdb", "1.4.69");
  });
});
