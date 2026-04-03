import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

async function withJsonPath<T>(
  run: (params: { root: string; pathname: string }) => Promise<T> | T,
): Promise<T> {
  return withTempDir({ prefix: "openclaw-json-file-" }, async (root) =>
    run({ root, pathname: path.join(root, "config.json") }),
  );
}

describe("json-file helpers", () => {
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
      expect(renameCall?.[0]).toMatch(
        new RegExp(`^${pathname.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\..+\\.tmp$`),
      );
      expect(renameSpy).toHaveBeenCalledWith(renameCall?.[0], pathname);
      expect(loadJsonFile(pathname)).toEqual({ enabled: true, count: 2 });
    });
  });
});
