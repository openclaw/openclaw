import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  preparePackageManifest,
  prepareRuntimePackageManifest,
  restorePackageManifest,
} from "../../scripts/package-manifest.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = tempDirs.make("openclaw-runtime-manifest-");
  const manifestPath = path.join(root, "package.json");
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
  writeFileSync(manifestPath, original);
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "dist/index.js"), "export const answer = 42;\n");
  writeFileSync(path.join(root, "dist/types.js"), "export const answer = 17;\n");
  writeFileSync(path.join(root, "dist/types.cjs"), "exports.answer = 23;\n");
  writeFileSync(path.join(root, "dist/fallback.js"), "export const answer = 99;\n");
  return {
    root,
    manifest,
    manifestPath,
    original,
    backupPath: path.join(root, ".artifacts/package-manifest/package.json.prepack-backup"),
    read: () => JSON.parse(readFileSync(manifestPath, "utf8")),
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

  it("refuses a runtime receipt whose prepared bytes do not match its source", async () => {
    const f = fixture();
    await prepareRuntimePackageManifest(f.root);
    const backup = readFileSync(f.backupPath, "utf8");
    const prepared = readFileSync(f.manifestPath, "utf8");
    const receipt = JSON.parse(backup);
    receipt.prepared = f.original;
    writeFileSync(f.backupPath, JSON.stringify(receipt));
    await expect(restorePackageManifest(f.root)).rejects.toThrow("Invalid runtime package");
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
