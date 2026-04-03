import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withJsonPath<T>(
  run: (params: { root: string; pathname: string }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) =>
    run({ root, pathname: path.join(root, "config.json") }),
  );
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

  it.each([
    {
      name: "new files",
      setup: () => {},
    },
    {
      name: "existing JSON files",
      setup: (pathname: string) => {
        fs.writeFileSync(pathname, '{"enabled":false}\n', "utf8");
      },
    },
  ])("writes the latest payload for $name", async ({ setup }) => {
    await withJsonPath(({ pathname }) => {
      setup(pathname);
      saveJsonFile(pathname, { enabled: true, count: 2 });
      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });
    });
  });

  it("writes through a sibling temp file before replacing the destination", async () => {
    await withJsonPath(({ pathname }) => {
      fs.writeFileSync(pathname, '{"enabled":false}\n', "utf8");
      const renameSpy = vi.spyOn(fs, "renameSync");

      saveJsonFile(pathname, { enabled: true, count: 2 });

      const renameCall = renameSpy.mock.calls.find(([, target]) => target === pathname);
      expect(renameCall?.[0]).toMatch(new RegExp(`^${escapeRegExp(pathname)}\\..+\\.tmp$`));
      expect(renameSpy).toHaveBeenCalledWith(renameCall?.[0], pathname);
      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });
    });
  });

  it.runIf(process.platform !== "win32")(
    "preserves symlink destinations when replacing existing JSON files",
    async () => {
      await withTempDir({ prefix: "openclaw-json-file-" }, async (root) => {
        const targetDir = path.join(root, "target");
        const targetPath = path.join(targetDir, "config.json");
        const linkPath = path.join(root, "config-link.json");
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(targetPath, '{"enabled":false}\n', "utf8");
        fs.symlinkSync(targetPath, linkPath);

        saveJsonFile(linkPath, { enabled: true, count: 2 });

        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(loadJsonFile(targetPath)).toEqual({ enabled: true, count: 2 });
        expect(loadJsonFile(linkPath)).toEqual({ enabled: true, count: 2 });
      });
    },
  );

  it("falls back to copy when rename-based overwrite fails", async () => {
    await withJsonPath(({ root, pathname }) => {
      fs.writeFileSync(pathname, '{"enabled":false}\n', "utf8");
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });

      saveJsonFile(pathname, { enabled: true, count: 2 });

      expect(renameSpy).toHaveBeenCalledOnce();
      expect(copySpy).toHaveBeenCalledOnce();
      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });
      expect(fs.readdirSync(root)).toEqual(["config.json"]);
    });
  });
});
