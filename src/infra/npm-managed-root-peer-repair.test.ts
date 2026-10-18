import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { expectedNpmCommand } from "../test-utils/npm-command.js";
import { repairManagedNpmRootOpenClawPeer } from "./npm-managed-root.js";
import {
  readManifest,
  successfulSpawn,
  useManagedNpmRootFixture,
  writeFixtureJson,
} from "./npm-managed-root.test-support.js";

const makeTempRoot = useManagedNpmRootFixture();

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.lstat(targetPath)).rejects.toThrow(
    expect.objectContaining({ code: "ENOENT", path: targetPath, syscall: "lstat" }),
  );
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

async function writePeerShims(npmRoot: string): Promise<void> {
  const modules = path.join(npmRoot, "node_modules");
  await fs.mkdir(path.join(modules, ".bin"), { recursive: true });
  for (const name of ["openclaw", "openclaw.cmd", "openclaw.ps1"]) {
    await fs.writeFile(path.join(modules, ".bin", name), "shim");
  }
  await fs.writeFile(path.join(modules, ".package-lock.json"), "hidden lockfile");
}

async function expectPeerMetadataRemoved(
  npmRoot: string,
  peerName: string,
  peerVersion: string,
): Promise<void> {
  await expect(readManifest(npmRoot)).resolves.toEqual({
    private: true,
    dependencies: { [peerName]: peerVersion },
  });
  const lockfile = JSON.parse(await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8"));
  expect(lockfile).toEqual({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { [peerName]: peerVersion } },
      [`node_modules/${peerName}`]: { version: peerVersion },
    },
    dependencies: {},
  });
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
      await writePeerShims(npmRoot);

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
      await writePeerShims(npmRoot);
      await fs.symlink(hostPackageRoot, managedPackageRoot, "dir");
    }
    const runCommand = vi.fn().mockResolvedValue(successfulSpawn);
    await expect(
      repairManagedNpmRootOpenClawPeer({ npmRoot, packageRoot: hostPackageRoot, runCommand }),
    ).resolves.toBe(linked);
    expect(runCommand).not.toHaveBeenCalled();
    await expect(readManifest(hostPackageRoot)).resolves.toEqual({ name: "openclaw", version });
    if (linked) {
      await expect(fs.realpath(managedPackageRoot)).resolves.toBe(
        await fs.realpath(hostPackageRoot),
      );
      await expectPeerMetadataRemoved(npmRoot, peerName, "1.4.69");
    } else {
      await expect(readManifest(npmRoot)).resolves.toMatchObject({
        dependencies: { openclaw: version, [peerName]: "1.4.69" },
      });
    }
  });
});
