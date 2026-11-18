import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
  const opened = vi.mocked(fs.openSync).mock;
  expect(fs.openSync).toHaveBeenCalled();
  expect(vi.mocked(fs.closeSync).mock.calls.map(([fd]) => fd)).toEqual(
    opened.results.filter((result) => result.type === "return").map((result) => result.value),
  );
}

const large = "x".repeat(512 * 1024 + 19);
it.each([
  ["empty", "", "none", ""],
  ["large", large, "none", large],
  ["short reads of a growing file", "a small static response", "grow", "a small static response"],
  ["truncated", "original longer content", "truncate", "short"],
])("reads and closes a %s file within its pinned size", (_name, body, change, expected) => {
  const file = createFile(body);
  if (change !== "none") {
    const read = fs.readSync;
    vi.spyOn(fs, "readSync")[change === "grow" ? "mockImplementation" : "mockImplementationOnce"](
      (
        fd,
        buffer,
        offset?: number | fs.ReadOptions,
        length?: number,
        position?: fs.ReadPosition | null,
      ) => {
        if (change === "grow") {
          fs.appendFileSync(file.filePath, "extra");
        } else {
          fs.writeFileSync(file.filePath, "short");
        }
        const options = typeof offset === "number" ? { offset, length, position } : offset;
        return read(
          fd,
          buffer,
          change === "grow" ? { ...options, length: Math.min(options?.length ?? 0, 3) } : options,
        );
      },
    );
  }
  const result = readControlUiFile(file);
  expect(result?.body).toBeInstanceOf(Uint8Array);
  expect(result && new TextDecoder().decode(result.body)).toBe(expected);
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
