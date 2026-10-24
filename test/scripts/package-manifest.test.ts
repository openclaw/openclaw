import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNpmPackageLock } from "../../scripts/generate-npm-package-lock.mts";
import {
  preparePackageManifest,
  prepareRuntimePackageManifest,
  restorePackageManifest,
} from "../../scripts/package-manifest.mjs";
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

function fixture() {
  const fixtureRoot = tempDirs.make("openclaw-runtime-manifest-");
  const fixtureManifestPath = path.join(fixtureRoot, "package.json");
  const manifest = {
    name: "openclaw-manifest-fixture",
    version: "1.0.0",
    type: "module",
    types: "./dist/index.d.ts",
    typings: "./dist/index.d.ts",
    typesVersions: { "*": { "*": ["dist/*.d.ts"] } },
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./types": {
        node: {
          "types@>=5.2": "./dist/types.d.ts",
          import: "./dist/types.js",
          require: "./dist/types.cjs",
        },
        default: "./dist/fallback.js",
      },
      "./array": [{ types: "./dist/types.d.ts", default: "./dist/types.js" }, null],
    },
    dependencies: { "runtime-dependency": "1.0.0" },
    devDependencies: { "workspace-tool": "workspace:*", "public-tool": "1.0.0" },
    scripts: { proof: "node scripts/crabbox-wrapper.mjs proof" },
  };
  const original = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(fixtureManifestPath, original);
  mkdirSync(path.join(fixtureRoot, "dist"));
  writeFileSync(path.join(fixtureRoot, "dist/index.js"), "export const answer = 42;\n");
  writeFileSync(path.join(fixtureRoot, "dist/types.js"), "export const answer = 17;\n");
  writeFileSync(path.join(fixtureRoot, "dist/types.cjs"), "exports.answer = 23;\n");
  writeFileSync(path.join(fixtureRoot, "dist/fallback.js"), "export const answer = 99;\n");
  return {
    root: fixtureRoot,
    manifest,
    manifestPath: fixtureManifestPath,
    original,
    backupPath: path.join(fixtureRoot, ".artifacts/package-manifest/package.json.prepack-backup"),
    read: () => JSON.parse(readFileSync(fixtureManifestPath, "utf8")),
  };
}

describe("private runtime package manifests", () => {
  it("resolves runtime exports without declarations and restores exact source bytes", async () => {
    const f = fixture();
    await prepareRuntimePackageManifest(f.root);
    const prepared = f.read();
    expect(prepared.private).toBe(true);
    expect(prepared.type).toBe("module");
    expect(prepared.types).toBeUndefined();
    expect(prepared.typings).toBeUndefined();
    expect(prepared.typesVersions).toBeUndefined();
    expect(prepared.exports).toEqual({
      ".": { default: "./dist/index.js" },
      "./types": {
        node: { import: "./dist/types.js", require: "./dist/types.cjs" },
        default: "./dist/fallback.js",
      },
      "./array": [{ default: "./dist/types.js" }, null],
    });
    expect(prepared.dependencies).toEqual(f.manifest.dependencies);
    expect(prepared.devDependencies).toEqual({ "public-tool": "1.0.0" });
    expect(prepared.scripts.proof).toBe("node dist/crabbox-wrapper.js proof");
    const consumer = path.join(f.root, "consumer.mjs");
    writeFileSync(
      consumer,
      'import { answer } from "openclaw-manifest-fixture";\n' +
        'import { answer as typedSubpath } from "openclaw-manifest-fixture/types";\n' +
        'import { createRequire } from "node:module";\n' +
        'export default [answer, typedSubpath, createRequire(import.meta.url)("openclaw-manifest-fixture/types").answer];\n',
    );
    expect((await import(pathToFileURL(consumer).href)).default).toEqual([42, 17, 23]);
    expect(existsSync(path.join(f.root, "dist/index.d.ts"))).toBe(false);
    await restorePackageManifest(f.root);
    expect(readFileSync(f.manifestPath, "utf8")).toBe(f.original);
    expect(existsSync(f.backupPath)).toBe(false);
    expect(await restorePackageManifest(f.root)).toBe(false);
  });

  it("preserves the public typed package contract", async () => {
    const f = fixture();
    await preparePackageManifest(f.root);
    const prepared = f.read();
    expect(prepared.private).toBeUndefined();
    expect(prepared.exports).toEqual(f.manifest.exports);
    expect(prepared.types).toBe(f.manifest.types);
    expect(prepared.typings).toBe(f.manifest.typings);
    expect(prepared.typesVersions).toEqual(f.manifest.typesVersions);
    await restorePackageManifest(f.root);
    expect(readFileSync(f.manifestPath, "utf8")).toBe(f.original);
  });

  it.each([
    ["public preparation", preparePackageManifest],
    ["runtime preparation", prepareRuntimePackageManifest],
  ] as const)(
    "refuses unrelated edits after %s and retains recovery ownership",
    async (_label, prepare) => {
      const f = fixture();
      await prepare(f.root);
      const prepared = readFileSync(f.manifestPath, "utf8");
      const edited = `${prepared}\n`;
      writeFileSync(f.manifestPath, edited);
      await expect(restorePackageManifest(f.root)).rejects.toThrow("changed after prepack");
      expect(readFileSync(f.manifestPath, "utf8")).toBe(edited);
      expect(existsSync(f.backupPath)).toBe(true);
      writeFileSync(f.manifestPath, prepared);
      await restorePackageManifest(f.root);
      expect(readFileSync(f.manifestPath, "utf8")).toBe(f.original);
    },
  );

  it("refuses restoration when the receipt no longer matches the current prepared bytes", async () => {
    const f = fixture();
    await prepareRuntimePackageManifest(f.root);
    const backup = readFileSync(f.backupPath, "utf8");
    const prepared = readFileSync(f.manifestPath, "utf8");
    const receipt = JSON.parse(backup);
    receipt.prepared = f.original;
    writeFileSync(f.backupPath, JSON.stringify(receipt));
    await expect(restorePackageManifest(f.root)).rejects.toThrow("changed after prepack");
    expect(readFileSync(f.manifestPath, "utf8")).toBe(prepared);
    writeFileSync(f.backupPath, backup);
    await restorePackageManifest(f.root);
    expect(readFileSync(f.manifestPath, "utf8")).toBe(f.original);
  });

  it("does not let public preparation authorize a runtime-only rewrite", async () => {
    const f = fixture();
    await prepareRuntimePackageManifest(f.root);
    const runtimeManifest = readFileSync(f.manifestPath, "utf8");
    await restorePackageManifest(f.root);
    await preparePackageManifest(f.root);
    writeFileSync(f.manifestPath, runtimeManifest);
    await expect(restorePackageManifest(f.root)).rejects.toThrow("changed after prepack");
    expect(readFileSync(f.manifestPath, "utf8")).toBe(runtimeManifest);
  });

  it("keeps one preparation owner across modes and recovers an interrupted source write", async () => {
    const f = fixture();
    await preparePackageManifest(f.root);
    const ownedReceipt = readFileSync(f.backupPath, "utf8");
    await expect(prepareRuntimePackageManifest(f.root)).rejects.toThrow(
      "Another package preparation",
    );
    expect(readFileSync(f.backupPath, "utf8")).toBe(ownedReceipt);
    writeFileSync(f.manifestPath, f.original);
    await restorePackageManifest(f.root);
    expect(readFileSync(f.manifestPath, "utf8")).toBe(f.original);
    expect(existsSync(f.backupPath)).toBe(false);
  });
});
