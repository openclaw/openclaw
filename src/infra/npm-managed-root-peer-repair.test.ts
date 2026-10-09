import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  await expect(fs.lstat(targetPath)).rejects.toThrow(
    expect.objectContaining({ code: "ENOENT", path: targetPath, syscall: "lstat" }),
  );
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
      expect(runCommand).toHaveBeenCalledExactlyOnceWith(
        expectedNpmCommand([
          "uninstall",
          "--loglevel=error",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "openclaw",
        ]),
        expect.objectContaining({
          cwd: npmRoot,
          timeoutMs: expectedTimeoutMs,
          env: expect.objectContaining({ npm_config_legacy_peer_deps: "true" }),
        }),
      );

      await expectPeerMetadataRemoved(npmRoot, "@openclaw/discord", "2026.5.4");
      await expectPathMissing(path.join(npmRoot, "node_modules", "openclaw"));
    },
  );

  it.each([false, true])("preserves the active host package (linked=%s)", async (linked) => {
    const npmRoot = await makeTempRoot();
    const managedPackageRoot = path.join(npmRoot, "node_modules", "openclaw");
    const hostPackageRoot = linked ? await makeTempRoot() : managedPackageRoot;
    await fs.mkdir(path.join(hostPackageRoot, "dist"), { recursive: true });
    const version = "2026.5.12-beta.6";
    const peerName = "@xdarkicex/openclaw-memory-libravdb";
    await writeManagedPeerMetadata(npmRoot, version, peerName, "1.4.69");
    await writeFixtureJson(path.join(hostPackageRoot, "package.json"), {
      name: "openclaw",
      version,
    });
    if (linked) {
      await writePeerShims(npmRoot, version);
      await fs.symlink(hostPackageRoot, managedPackageRoot, "dir");
    }
    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({
        npmRoot,
        packageRoot: hostPackageRoot,
        runCommand,
      }),
    ).resolves.toBe(linked);
    expect(runCommand).not.toHaveBeenCalled();
    await expect(
      fs.readFile(path.join(hostPackageRoot, "package.json"), "utf8"),
    ).resolves.toContain(version);
    if (linked) {
      await expect(fs.realpath(managedPackageRoot)).resolves.toBe(
        await fs.realpath(hostPackageRoot),
      );
      await expectPeerMetadataRemoved(npmRoot, peerName, "1.4.69");
    } else {
      await expect(
        fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
      ).resolves.toMatchObject({ dependencies: { openclaw: version, [peerName]: "1.4.69" } });
    }
  });
});
