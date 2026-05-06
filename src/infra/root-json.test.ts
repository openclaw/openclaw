import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readRootJsonObjectSync } from "./root-json.js";

describe("readRootJsonObjectSync", () => {
  it("reads JSON objects through a root-bounded open", async () => {
    await withTempDir({ prefix: "openclaw-root-json-" }, async (rootDir) => {
      fs.writeFileSync(path.join(rootDir, "config.json"), JSON.stringify({ name: "demo" }));

      const result = readRootJsonObjectSync({
        rootDir,
        relativePath: "config.json",
        boundaryLabel: "test root",
        rejectHardlinks: true,
      });

      expect(result).toMatchObject({ ok: true, raw: { name: "demo" } });
    });
  });

  it("rejects non-object JSON and paths outside the root", async () => {
    await withTempDir({ prefix: "openclaw-root-json-" }, async (rootDir) => {
      const parentJsonPath = path.join(path.dirname(rootDir), `${path.basename(rootDir)}.json`);
      fs.writeFileSync(path.join(rootDir, "array.json"), "[]");
      fs.writeFileSync(parentJsonPath, JSON.stringify({ name: "outside" }));
      try {
        expect(
          readRootJsonObjectSync({
            rootDir,
            relativePath: "array.json",
            boundaryLabel: "test root",
          }),
        ).toMatchObject({ ok: false, reason: "not-object" });
        expect(
          readRootJsonObjectSync({
            rootDir,
            relativePath: "../outside-root-json-test.json",
            boundaryLabel: "test root",
          }),
        ).toMatchObject({ ok: false, reason: "open" });
      } finally {
        fs.rmSync(parentJsonPath, { force: true });
      }
    });
  });
});
