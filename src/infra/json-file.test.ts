import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

describe("json-file helpers", () => {
  it("returns undefined for missing and invalid JSON files", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "config.json");
      expect(loadJsonFile(pathname)).toBeUndefined();

      fs.writeFileSync(pathname, "{", "utf8");
      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });

  it("returns undefined when the target path is a directory", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "config-dir");
      fs.mkdirSync(pathname);

      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });

  it("creates parent dirs, writes a trailing newline, and loads the saved object", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "nested", "config.json");
      saveJsonFile(pathname, { enabled: true, count: 2 });

      const raw = fs.readFileSync(pathname, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });

      const fileMode = fs.statSync(pathname).mode & 0o777;
      const dirMode = fs.statSync(path.dirname(pathname)).mode & 0o777;
      if (process.platform === "win32") {
        expect(fileMode & 0o111).toBe(0);
      } else {
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      }
    });
  });

  it("overwrites existing JSON files with the latest payload", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "config.json");
      fs.writeFileSync(pathname, '{"enabled":false}\n', "utf8");

      saveJsonFile(pathname, { enabled: true, count: 2 });

      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });
    });
  });

  // An external mirror process (e.g. the MCTL s3-sync sidecar) must never
  // observe a partial / zero-byte copy of the target file while a save is in
  // flight. Verify the save writes through a temp file and leaves no
  // residual `.tmp.*` artefacts behind in the parent directory.
  it("uses atomic temp+rename (no residual .tmp siblings after save)", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "state.json");
      saveJsonFile(pathname, { v: 1 });
      saveJsonFile(pathname, { v: 2 });

      const siblings = fs.readdirSync(root);
      expect(siblings).toContain("state.json");
      const leftovers = siblings.filter((name) => name !== "state.json");
      expect(leftovers).toEqual([]);
      expect(loadJsonFile(pathname)).toEqual({ v: 2 });
    });
  });

  // Operators redirect state files onto another volume via symlinks, and the
  // very first save on a fresh boot usually creates the target file. Use
  // lstat+readlink rather than realpathSync so this case preserves the
  // symlink instead of silently clobbering it with a regular file.
  it.skipIf(process.platform === "win32")(
    "preserves symlinks when the target does not yet exist",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const realDir = path.join(root, "real");
        fs.mkdirSync(realDir);
        const realTarget = path.join(realDir, "state.json");
        // target file intentionally does NOT exist yet.

        const linkDir = path.join(root, "link");
        fs.mkdirSync(linkDir);
        const pathname = path.join(linkDir, "state.json");
        fs.symlinkSync(realTarget, pathname);

        saveJsonFile(pathname, { first: true });

        expect(fs.lstatSync(pathname).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(realTarget)).toBe(true);
        expect(JSON.parse(fs.readFileSync(realTarget, "utf8"))).toEqual({ first: true });
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows a multi-hop symlink chain (A -> B -> real)",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const realTarget = path.join(root, "real.json");
        fs.writeFileSync(realTarget, '{"seed":true}\n', "utf8");
        const hopB = path.join(root, "B.json");
        const hopA = path.join(root, "A.json");
        fs.symlinkSync(realTarget, hopB);
        fs.symlinkSync(hopB, hopA);

        saveJsonFile(hopA, { v: 7 });

        // A and B stay symlinks, real.json carries the new content.
        expect(fs.lstatSync(hopA).isSymbolicLink()).toBe(true);
        expect(fs.lstatSync(hopB).isSymbolicLink()).toBe(true);
        expect(JSON.parse(fs.readFileSync(realTarget, "utf8"))).toEqual({ v: 7 });
      });
    },
  );

  it("removes the temp file when serialization fails", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "state.json");
      // Cyclic object — JSON.stringify throws mid-save after the temp file
      // has been created; the cleanup path must drop it.
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(() => saveJsonFile(pathname, cyclic)).toThrow();

      const leftovers = fs.readdirSync(root);
      expect(leftovers).toEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "detects symlink cycles",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const a = path.join(root, "a.json");
        const b = path.join(root, "b.json");
        fs.symlinkSync(b, a);
        fs.symlinkSync(a, b);
        expect(() => saveJsonFile(a, { v: 1 })).toThrow(/symlink cycle/);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "follows symlinks on save so the link is preserved, target is updated",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const realDir = path.join(root, "real");
        const linkDir = path.join(root, "link");
        fs.mkdirSync(realDir);
        const realTarget = path.join(realDir, "state.json");
        fs.writeFileSync(realTarget, '{"seed":true}\n', "utf8");

        const pathname = path.join(linkDir, "state.json");
        fs.mkdirSync(linkDir);
        fs.symlinkSync(realTarget, pathname);

        saveJsonFile(pathname, { v: 2 });

        // Link entry stays a symlink, target file carries the new content.
        expect(fs.lstatSync(pathname).isSymbolicLink()).toBe(true);
        expect(JSON.parse(fs.readFileSync(realTarget, "utf8"))).toEqual({ v: 2 });
        // No .tmp.* leftovers under either dir.
        expect(fs.readdirSync(realDir).filter((n) => n !== "state.json")).toEqual([]);
        expect(fs.readdirSync(linkDir).filter((n) => n !== "state.json")).toEqual([]);
      });
    },
  );
});
