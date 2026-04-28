import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

const SAVED_PAYLOAD = { enabled: true, count: 2 };
const PREVIOUS_JSON = '{"enabled":false}\n';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeExistingJson(pathname: string) {
  fs.writeFileSync(pathname, PREVIOUS_JSON, "utf8");
}

async function withJsonPath<T>(
  run: (params: { root: string; pathname: string }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) =>
    run({ root, pathname: path.join(root, "config.json") }),
  );
}

async function withJsonSymlink<T>(
  run: (params: {
    root: string;
    targetDir: string;
    targetPath: string;
    linkPath: string;
  }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
    const targetDir = path.join(root, "target");
    return run({
      root,
      targetDir,
      targetPath: path.join(targetDir, "config.json"),
      linkPath: path.join(root, "config-link.json"),
    });
  });
}

function expectSavedPayloadThroughSymlink(linkPath: string, targetPath: string) {
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(loadJsonFile(targetPath)).toEqual(SAVED_PAYLOAD);
  expect(loadJsonFile(linkPath)).toEqual(SAVED_PAYLOAD);
}

describe("json-file helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "missing files",
      setup: () => {},
    },
    {
      name: "invalid JSON files",
      setup: (pathname: string) => {
        fs.writeFileSync(pathname, "{", "utf8");
      },
    },
    {
      name: "directory targets",
      setup: (pathname: string) => {
        fs.mkdirSync(pathname);
      },
    },
  ])("returns undefined for $name", async ({ setup }) => {
    await withJsonPath(({ pathname }) => {
      setup(pathname);
      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });

  it("creates parent dirs, writes a trailing newline, and loads the saved object", async () => {
    await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
      const pathname = path.join(root, "nested", "config.json");
      saveJsonFile(pathname, SAVED_PAYLOAD);

      const raw = fs.readFileSync(pathname, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);

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

  it.each([
    {
      name: "new files",
      setup: () => {},
    },
    {
      name: "existing JSON files",
      setup: writeExistingJson,
    },
  ])("writes the latest payload for $name", async ({ setup }) => {
    await withJsonPath(({ pathname }) => {
      setup(pathname);
      saveJsonFile(pathname, SAVED_PAYLOAD);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
    });
  });

  it("writes through a sibling temp file before replacing the destination", async () => {
    await withJsonPath(({ pathname }) => {
      writeExistingJson(pathname);
      const renameSpy = vi.spyOn(fs, "renameSync");

      saveJsonFile(pathname, SAVED_PAYLOAD);

      const renameCall = renameSpy.mock.calls.find(([, target]) => target === pathname);
      expect(renameCall?.[0]).toMatch(new RegExp(`^${escapeRegExp(pathname)}\\..+\\.tmp$`));
      expect(renameSpy).toHaveBeenCalledWith(renameCall?.[0], pathname);
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves symlink destinations when replacing existing JSON files",
    async () => {
      await withJsonSymlink(({ targetDir, targetPath, linkPath }) => {
        fs.mkdirSync(targetDir, { recursive: true });
        writeExistingJson(targetPath);
        fs.symlinkSync(targetPath, linkPath);

        saveJsonFile(linkPath, SAVED_PAYLOAD);

        expectSavedPayloadThroughSymlink(linkPath, targetPath);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "creates a missing target file through an existing symlink",
    async () => {
      await withJsonSymlink(({ targetDir, targetPath, linkPath }) => {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.symlinkSync(targetPath, linkPath);

        saveJsonFile(linkPath, SAVED_PAYLOAD);

        expectSavedPayloadThroughSymlink(linkPath, targetPath);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not create missing target directories through an existing symlink",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const missingTargetDir = path.join(root, "missing-target");
        const targetPath = path.join(missingTargetDir, "config.json");
        const linkPath = path.join(root, "config-link.json");
        fs.symlinkSync(targetPath, linkPath);

        expect(() => saveJsonFile(linkPath, SAVED_PAYLOAD)).toThrow(
          expect.objectContaining({ code: "ENOENT" }),
        );
        expect(fs.existsSync(missingTargetDir)).toBe(false);
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      });
    },
  );

  it("falls back to copy when rename-based overwrite fails", async () => {
    await withJsonPath(({ root, pathname }) => {
      writeExistingJson(pathname);
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      saveJsonFile(pathname, SAVED_PAYLOAD);

      expect(renameSpy).toHaveBeenCalledOnce();
      expect(copySpy).toHaveBeenCalledOnce();
      expect(loadJsonFile(pathname)).toEqual(SAVED_PAYLOAD);
      expect(fs.readdirSync(root)).toEqual(["config.json"]);
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
    "fails loud when symlink target directory is missing (e.g. unmounted volume)",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const linkDir = path.join(root, "link");
        fs.mkdirSync(linkDir);
        const pathname = path.join(linkDir, "state.json");
        // Absolute target pointing into a directory tree that does not exist.
        const missing = path.join(root, "missing-mount", "state.json");
        fs.symlinkSync(missing, pathname);

        expect(() => saveJsonFile(pathname, { v: 1 })).toThrow(
          /symlink target directory does not exist/,
        );
        // And the bogus local tree must not be materialised.
        expect(fs.existsSync(path.join(root, "missing-mount"))).toBe(false);
      });
    },
  );

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
