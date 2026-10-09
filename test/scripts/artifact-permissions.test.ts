import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertArtifactTreeReadable,
  declaredArtifactExecutableFiles,
  ensureGeneratedArtifactDirectory,
  normalizeGeneratedArtifactTree,
} from "../../src/shared/artifact-permissions.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const mode = (file: string) => fs.statSync(file).mode & 0o7777;

describe("generated artifact permission boundary", () => {
  it.skipIf(process.platform === "win32")(
    "repairs only generated descendants and preserves bytes and launcher intent",
    () => {
      const owner = fs.realpathSync(roots.make("artifact-permissions-"));
      fs.chmodSync(owner, 0o700);
      const output = path.join(owner, "dist/nested");
      fs.mkdirSync(output, { recursive: true, mode: 0o700 });
      const asset = path.join(output, "asset.js");
      const launcher = path.join(output, "launcher.js");
      const declared = path.join(output, "declared.js");
      fs.writeFileSync(asset, "immutable data", { mode: 0o600 });
      fs.writeFileSync(launcher, "launcher", { mode: 0o700 });
      fs.writeFileSync(declared, "declared launcher", { mode: 0o600 });
      expect(() => assertArtifactTreeReadable(output)).toThrow("world-readable");
      expect(mode(asset)).toBe(0o600);
      ensureGeneratedArtifactDirectory(output, owner);
      normalizeGeneratedArtifactTree(output, { executableFiles: ["declared.js"] });
      expect(
        assertArtifactTreeReadable(output, {
          ownerRoot: owner,
          executableFiles: ["declared.js"],
          readFiles: true,
        }).files,
      ).toBe(3);
      expect([owner, path.dirname(output), output, asset, launcher, declared].map(mode)).toEqual([
        0o700, 0o755, 0o755, 0o644, 0o755, 0o755,
      ]);
      expect(fs.readFileSync(asset, "utf8")).toBe("immutable data");
      fs.chmodSync(declared, 0o644);
      expect(() =>
        assertArtifactTreeReadable(output, { executableFiles: ["declared.js"] }),
      ).toThrow("executable");
    },
  );

  it.skipIf(process.platform === "win32")(
    "preflights links before any chmod and rejects symlinked parents",
    () => {
      const root = fs.realpathSync(roots.make("artifact-links-"));
      fs.chmodSync(root, 0o700);
      const output = path.join(root, "dist");
      const privateRoot = path.join(root, "private");
      fs.mkdirSync(output, { mode: 0o700 });
      fs.mkdirSync(privateRoot, { mode: 0o700 });
      const file = path.join(output, "a.js");
      fs.writeFileSync(file, "keep", { mode: 0o600 });
      fs.symlinkSync(privateRoot, path.join(output, "z-link"), "dir");
      expect(() => normalizeGeneratedArtifactTree(output)).toThrow("closure");
      expect([output, file, privateRoot].map(mode)).toEqual([0o700, 0o600, 0o700]);
      expect(() =>
        ensureGeneratedArtifactDirectory(path.join(output, "z-link/child"), root),
      ).toThrow("real directory");
      expect(mode(output)).toBe(0o700);
      fs.unlinkSync(path.join(output, "z-link"));
      normalizeGeneratedArtifactTree(output);
      fs.symlinkSync("a.js", path.join(output, "alias.js"));
      expect(
        assertArtifactTreeReadable(output, { allowLinksWithin: root, readFiles: true }).files,
      ).toBe(1);
      fs.symlinkSync(output, path.join(root, "linked"), "dir");
      expect(() => normalizeGeneratedArtifactTree(path.join(root, "linked/a.js"))).toThrow(
        "parent",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects hardlinked mutation before widening any generated or private inode",
    () => {
      const root = fs.realpathSync(roots.make("artifact-hardlink-"));
      fs.chmodSync(root, 0o700);
      const output = path.join(root, "dist");
      fs.mkdirSync(output, { mode: 0o700 });
      const privateFile = path.join(root, "private.js");
      fs.writeFileSync(privateFile, "private source", { mode: 0o600 });
      fs.linkSync(privateFile, path.join(output, "linked.js"));
      expect(() => normalizeGeneratedArtifactTree(output)).toThrow("exclusively owned");
      expect([output, privateFile].map(mode)).toEqual([0o700, 0o600]);
      expect(fs.readFileSync(privateFile, "utf8")).toBe("private source");
    },
  );

  it.each([
    "../private",
    "/absolute",
    "C:\\private",
    "C:/private",
    "a\\b",
    "a/../b",
    "a//b",
    "./",
    "a/./b",
    "a\0b",
  ])("rejects non-package-relative executable path %s", (file) => {
    expect(() => declaredArtifactExecutableFiles({ bin: file })).toThrow("Invalid");
  });
  it("honors both package executable declarations and rejects invalid declaration types", () => {
    expect(
      declaredArtifactExecutableFiles({
        bin: { app: "./app.js" },
        publishConfig: { executableFiles: ["app.js", "helper.js"] },
      }),
    ).toEqual(["app.js", "helper.js"]);
    expect(() => declaredArtifactExecutableFiles({ bin: [] })).toThrow("bin");
    expect(() =>
      declaredArtifactExecutableFiles({ publishConfig: { executableFiles: "helper" } }),
    ).toThrow("array");
  });
});
