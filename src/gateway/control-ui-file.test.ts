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
  it.each([
    { name: "empty", body: "", change: "none", expected: "" },
    {
      name: "large",
      body: "x".repeat(512 * 1024 + 19),
      change: "none",
      expected: "x".repeat(512 * 1024 + 19),
    },
    {
      name: "short reads of a growing file",
      body: "a small static response",
      change: "grow",
      expected: "a small static response",
    },
    { name: "truncated", body: "original longer content", change: "truncate", expected: "short" },
  ])("reads and closes a $name file within its pinned size", ({ body, change, expected }) => {
    const file = createFile(body);
    if (change !== "none") {
      const read = fs.readSync;
      const readSpy = vi.spyOn(fs, "readSync");
      const readChanged: Parameters<typeof readSpy.mockImplementation>[0] = (
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
      };
      if (change === "grow") {
        readSpy.mockImplementation(readChanged);
      } else {
        readSpy.mockImplementationOnce(readChanged);
      }
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
});
