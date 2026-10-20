import { writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateNpmPackageLock } from "../../scripts/generate-npm-package-lock.mts";
import { preparePackageManifest, restorePackageManifest } from "../../scripts/package-manifest.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../scripts/generate-npm-package-lock.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/generate-npm-package-lock.mts")>()),
  generateNpmPackageLock: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const optional = { version: "1.2.3", optional: true };
const nativeVersions = { "native-darwin": "1.2.3", "native-linux": "1.2.3" };
const platformLock = JSON.stringify({
  packages: {
    "node_modules/native-linux": { ...optional, os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
    "node_modules/native-darwin": { ...optional, os: ["darwin"], cpu: ["arm64"] },
    "node_modules/required": { version: "2.0.0", os: ["linux"] },
  },
});

let root: string, manifestPath: string;
const readManifest = () => readFile(manifestPath, "utf8");
const writeManifest = (value: object) => writeFile(manifestPath, JSON.stringify(value));
beforeEach(() => {
  root = tempDirs.make("package-manifest-");
  manifestPath = path.join(root, "package.json");
  vi.mocked(generateNpmPackageLock).mockReset().mockReturnValue(platformLock);
});
it("keeps transitive platform payloads optional when npm reloads a global bundle", async () => {
  const original = {
    name: "fixture",
    dependencies: { bundled: "1.0.0", required: "2.0.0" },
    bundleDependencies: ["bundled"],
    optionalDependencies: { existing: "^3.0.0" },
  };
  const originalBytes = `${JSON.stringify(original)}\n`;
  await writeFile(manifestPath, originalBytes);
  await preparePackageManifest(root);
  expect(JSON.parse(await readManifest())).toEqual({
    ...original,
    optionalDependencies: { existing: "^3.0.0", ...nativeVersions },
  });
  // Recovery must use captured bytes, even if registry/lock generation is unavailable.
  vi.mocked(generateNpmPackageLock).mockImplementation(() => {
    throw new Error("registry unavailable");
  });
  expect(await restorePackageManifest(root)).toBe(true);
  expect(await readManifest()).toBe(originalBytes);
  expect(await restorePackageManifest(root)).toBe(false);
});
it.each(["during resolution", "after preparation"])("preserves edits %s", async (when) => {
  await writeManifest({ bundleDependencies: ["bundled"] });
  const edited = JSON.stringify({ bundleDependencies: ["bundled"], description: "new edit" });
  if (when === "during resolution") {
    vi.mocked(generateNpmPackageLock).mockImplementation(() => {
      writeFileSync(manifestPath, edited);
      return platformLock;
    });
    await expect(preparePackageManifest(root)).rejects.toThrow("changed while preparing");
    expect(await restorePackageManifest(root)).toBe(false);
  } else {
    await preparePackageManifest(root);
    await writeFile(manifestPath, edited);
    await expect(restorePackageManifest(root)).rejects.toThrow("changed after prepack");
  }
  expect(await readManifest()).toBe(edited);
});
it("does not resolve a dependency graph for an unbundled package", async () => {
  await writeManifest({ name: "unbundled" });
  expect(await preparePackageManifest(root)).toBe(false);
  expect(generateNpmPackageLock).not.toHaveBeenCalled();
});
it.each([false, true])(
  "recovers v2026.9.8 raw receipts without overwriting edits (%s)",
  async (edited) => {
    const backupPath = path.join(root, ".artifacts/package-manifest/package.json.prepack-backup");
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
      expect(await readManifest()).toBe(currentBytes);
      expect(await readFile(backupPath, "utf8")).toBe(originalBytes);
    } else {
      expect(await restorePackageManifest(root)).toBe(true);
      expect(await readManifest()).toBe(originalBytes);
      expect(await restorePackageManifest(root)).toBe(false);
    }
    expect(generateNpmPackageLock).not.toHaveBeenCalled();
  },
);
