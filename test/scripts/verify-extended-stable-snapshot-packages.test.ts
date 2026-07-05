import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyExtendedStableSnapshotPackages } from "../../scripts/verify-extended-stable-snapshot-packages.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => cleanupTempDirs(tempDirs));

function makeReleaseRoot(version: string): string {
  const rootDir = makeTempRepoRoot(tempDirs, "openclaw-snapshot-proof-");
  writeJsonFile(join(rootDir, "package.json"), { version });
  mkdirSync(join(rootDir, "release"), { recursive: true });
  writeFileSync(
    join(rootDir, "release/extended-stable-plugin-support.json"),
    readFileSync("release/extended-stable-plugin-support.json", "utf8"),
  );
  for (const pluginId of ["codex", "discord", "matrix", "slack"]) {
    const packageDir = join(rootDir, "extensions", pluginId);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "README.md"), `# ${pluginId}\n`);
    writeJsonFile(join(packageDir, "package.json"), {
      name: `@openclaw/${pluginId}`,
      version,
      type: "module",
      repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
      openclaw: {
        extensions: ["./index.ts"],
        install: { npmSpec: `@openclaw/${pluginId}` },
        compat: { pluginApi: `>=${version}` },
        build: { openclawVersion: version },
        release: { publishToNpm: true },
      },
    });
  }
  return rootDir;
}

describe("extended-stable snapshot package proof", () => {
  it("reads and installs every uncovered official plugin at same-month patch 33", async () => {
    const verifyPackage = vi.fn(async () => ({ integrity: "sha512-matrix" }));
    const installPackages = vi.fn();

    await expect(
      verifyExtendedStableSnapshotPackages(makeReleaseRoot("2026.6.34"), {
        verifyPackage,
        installPackages,
      }),
    ).resolves.toEqual([
      {
        packageName: "@openclaw/matrix",
        version: "2026.6.33",
        npmIntegrity: "sha512-matrix",
        installVerified: true,
      },
    ]);
    expect(verifyPackage).toHaveBeenCalledWith("@openclaw/matrix", "2026.6.33");
    expect(installPackages).toHaveBeenCalledWith(["@openclaw/matrix"], "2026.6.34", "2026.6.33");
  });
});
