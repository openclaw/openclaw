import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNpmPackageLock } from "../../scripts/generate-npm-package-lock.mts";
import { preparePackageManifest, restorePackageManifest } from "../../scripts/package-manifest.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/generate-npm-package-lock.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/generate-npm-package-lock.mts")>()),
  generateNpmPackageLock: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const platformLock = JSON.stringify({
  packages: {
    "node_modules/native-linux": {
      version: "1.2.3",
      optional: true,
      os: ["linux"],
      cpu: ["x64"],
      libc: ["glibc"],
    },
    "node_modules/native-darwin": {
      version: "1.2.3",
      optional: true,
      os: ["darwin"],
      cpu: ["arm64"],
    },
    "node_modules/required": { version: "2.0.0", os: ["linux"] },
  },
});

describe("package manifest preparation", () => {
  beforeEach(() => {
    vi.mocked(generateNpmPackageLock).mockReset().mockReturnValue(platformLock);
  });

  it("keeps transitive platform payloads optional when npm reloads a global bundle", async () => {
    const root = tempDirs.make("package-platform-optionals-");
    const manifestPath = path.join(root, "package.json");
    const original = {
      name: "fixture",
      dependencies: { bundled: "1.0.0", required: "2.0.0" },
      bundleDependencies: ["bundled"],
      optionalDependencies: { existing: "^3.0.0" },
    };
    const originalBytes = `${JSON.stringify(original)}\n`;
    await writeFile(manifestPath, originalBytes);

    await preparePackageManifest(root);
    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      ...original,
      optionalDependencies: {
        existing: "^3.0.0",
        "native-darwin": "1.2.3",
        "native-linux": "1.2.3",
      },
    });

    // Recovery must use captured bytes, even if registry/lock generation is unavailable.
    vi.mocked(generateNpmPackageLock).mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    expect(await restorePackageManifest(root)).toBe(true);
    expect(await readFile(manifestPath, "utf8")).toBe(originalBytes);
    expect(await restorePackageManifest(root)).toBe(false);
  });

  it("preserves source edits made after preparation", async () => {
    const root = tempDirs.make("package-manifest-owner-");
    const manifestPath = path.join(root, "package.json");
    await writeFile(manifestPath, JSON.stringify({ bundleDependencies: ["bundled"] }));
    await preparePackageManifest(root);
    const edited = JSON.stringify({ bundleDependencies: ["bundled"], description: "new edit" });
    await writeFile(manifestPath, edited);

    await expect(restorePackageManifest(root)).rejects.toThrow("changed after prepack");
    expect(await readFile(manifestPath, "utf8")).toBe(edited);
  });

  it("does not resolve a dependency graph for an unbundled package", async () => {
    const root = tempDirs.make("package-manifest-unbundled-");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "unbundled" }));
    expect(await preparePackageManifest(root)).toBe(false);
    expect(generateNpmPackageLock).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a manifest edited during dependency resolution", async () => {
    const root = tempDirs.make("package-manifest-resolution-");
    const manifestPath = path.join(root, "package.json");
    await writeFile(manifestPath, JSON.stringify({ bundleDependencies: ["bundled"] }));
    const edited = JSON.stringify({ description: "concurrent edit" });
    vi.mocked(generateNpmPackageLock).mockImplementation(() => {
      writeFileSync(manifestPath, edited);
      return platformLock;
    });

    await expect(preparePackageManifest(root)).rejects.toThrow("changed while preparing");
    expect(await readFile(manifestPath, "utf8")).toBe(edited);
    expect(await restorePackageManifest(root)).toBe(false);
  });

  it.each([false, true])(
    "recovers v2026.9.8 raw receipts without overwriting edits (%s)",
    async (edited) => {
      const root = tempDirs.make("package-manifest-legacy-");
      const manifestPath = path.join(root, "package.json");
      const backupPath = path.join(
        root,
        ".artifacts",
        "package-manifest",
        "package.json.prepack-backup",
      );
      const original = {
        name: "fixture",
        scripts: { check: "node scripts/crabbox-wrapper.mjs --check" },
        devDependencies: { local: "workspace:*", tooling: "1.0.0" },
      };
      const originalBytes = `${JSON.stringify(original)}\n`;
      const prepared = {
        ...original,
        scripts: { check: "node dist/crabbox-wrapper.js --check" },
        devDependencies: { tooling: "1.0.0" },
        ...(edited ? { description: "intervening edit" } : {}),
      };
      const currentBytes = `${JSON.stringify(prepared, null, 2)}\n`;
      await mkdir(path.dirname(backupPath), { recursive: true });
      await writeFile(backupPath, originalBytes);
      await writeFile(manifestPath, currentBytes);

      if (edited) {
        await expect(restorePackageManifest(root)).rejects.toThrow("changed after prepack");
        expect(await readFile(manifestPath, "utf8")).toBe(currentBytes);
        expect(await readFile(backupPath, "utf8")).toBe(originalBytes);
      } else {
        expect(await restorePackageManifest(root)).toBe(true);
        expect(await readFile(manifestPath, "utf8")).toBe(originalBytes);
        expect(await restorePackageManifest(root)).toBe(false);
      }
      expect(generateNpmPackageLock).not.toHaveBeenCalled();
    },
  );
});
