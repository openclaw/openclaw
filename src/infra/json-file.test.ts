import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveJsonFile } from "./json-file.js";

describe("saveJsonFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the write when chmod is not permitted by the filesystem", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-"));
    const pathname = path.join(tmpDir, "state.json");
    const chmodError = Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw chmodError;
    });

    expect(() => saveJsonFile(pathname, { ok: true })).not.toThrow();
    expect(JSON.parse(fs.readFileSync(pathname, "utf8"))).toEqual({ ok: true });
  });

  it("still throws unexpected chmod failures", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-"));
    const pathname = path.join(tmpDir, "state.json");
    const chmodError = Object.assign(new Error("access denied"), {
      code: "EACCES",
    });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw chmodError;
    });

    expect(() => saveJsonFile(pathname, { ok: true })).toThrow("access denied");
  });
});
