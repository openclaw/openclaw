import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveJsonFile } from "./json-file.js";

describe("saveJsonFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores permission errors when applying chmod", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-json-file-"));
    const target = path.join(tempDir, "data.json");
    const chmodError = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw chmodError;
    });

    expect(() => saveJsonFile(target, { ok: true })).not.toThrow();
    expect(chmodSpy).toHaveBeenCalledWith(target, 0o600);

    const stored = JSON.parse(await fsPromises.readFile(target, "utf8")) as { ok?: boolean };
    expect(stored.ok).toBe(true);

    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it("rethrows unexpected chmod errors", async () => {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-json-file-"));
    const target = path.join(tempDir, "data.json");
    const chmodError = Object.assign(new Error("i/o error"), { code: "EIO" });

    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw chmodError;
    });

    expect(() => saveJsonFile(target, { ok: true })).toThrowError("i/o error");
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });
});
