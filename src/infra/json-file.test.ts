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
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
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
});
