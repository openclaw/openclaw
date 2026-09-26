import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readControlUiFile } from "./control-ui-file.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function createFile(body: string) {
  const rootPath = tempDirs.make("openclaw-ui-read-");
  const filePath = path.join(rootPath, "asset.txt");
  fs.writeFileSync(filePath, body);
  vi.spyOn(fs, "openSync");
  vi.spyOn(fs, "closeSync");
  return { rootPath, filePath, rejectHardlinks: true, readBody: true };
}

function expectClosed() {
  expect(fs.openSync).toHaveBeenCalled();
  expect(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd)).toEqual(
    vi
      .mocked(fs.openSync)
      .mock.results.filter((result) => result.type === "return")
      .map((result) => result.value),
  );
}

describe("pinned Control UI file reads", () => {
  it.each([0, 512 * 1024 + 19])("reads and closes a file of %i bytes", (size) => {
    const body = "x".repeat(size);
    const file = createFile(body);
    const result = readControlUiFile(file);
    expect(result?.body).toBeInstanceOf(Uint8Array);
    expect(result && new TextDecoder().decode(result.body)).toBe(body);
    expectClosed();
  });

  it("fills short reads without adding bytes beyond the pinned size", () => {
    const body = "a small static response";
    const file = createFile(body);
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((fd, buffer, options) => {
      fs.appendFileSync(file.filePath, "extra");
      return read(fd, buffer, { ...options, length: Math.min(options?.length ?? 0, 3) });
    });
    const result = readControlUiFile(file);
    expect(result && new TextDecoder().decode(result.body)).toBe(body);
    expectClosed();
  });

  it("returns only bytes read when the pinned file is truncated", () => {
    const file = createFile("original longer content");
    const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementationOnce((fd, buffer, options) => {
      fs.writeFileSync(file.filePath, "short");
      return read(fd, buffer, options);
    });
    const result = readControlUiFile(file);
    expect(result && new TextDecoder().decode(result.body)).toBe("short");
    expectClosed();
  });

  it("closes the descriptor when a read fails", () => {
    const file = createFile("response");
    const error = Object.assign(new Error("synthetic read failure"), { code: "EIO" });
    vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => readControlUiFile(file)).toThrow(error);
    expectClosed();
  });

  it("serves metadata above the body limit but closes before rejecting a body read", () => {
    const file = createFile("");
    fs.truncateSync(file.filePath, 2 ** 31);
    vi.spyOn(fs, "readSync");
    expect(readControlUiFile({ ...file, readBody: false })).toEqual({
      path: fs.realpathSync(file.filePath),
      size: 2 ** 31,
      mtimeMs: fs.statSync(file.filePath).mtimeMs,
    });
    expect(fs.readSync).not.toHaveBeenCalled();
    expectClosed();
    expect(() => readControlUiFile(file)).toThrow(
      expect.objectContaining({ code: "ERR_FS_FILE_TOO_LARGE" }),
    );
    expectClosed();
  });
});
