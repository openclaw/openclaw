// Tests ignore-rules file loading: empty catch, ENOENT suppression, and non-ENOENT re-throw.
import path from "node:path";
import ignore from "ignore";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(p: import("node:fs").PathLike) => boolean>(),
  readFileSyncMock: vi.fn<(p: import("node:fs").PathLike, ...rest: unknown[]) => string>(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

let addIgnoreRules: typeof import("./ignore-rules.js").addIgnoreRules;

beforeAll(async () => {
  ({ addIgnoreRules } = await import("./ignore-rules.js"));
});

beforeEach(() => {
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("addIgnoreRules", () => {
  it("returns the matcher unchanged when no ignore files exist", () => {
    existsSyncMock.mockReturnValue(false);
    const ig = ignore();
    expect(addIgnoreRules("/root/sub", "/root", ig)).toBe(ig);
  });

  it("silently skips a file that vanishes between exists and read (ENOENT)", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation(() => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => addIgnoreRules("/root", "/root", ignore())).not.toThrow();
  });

  it("re-throws permission-denied errors (EACCES)", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    expect(() => addIgnoreRules("/root", "/root", ignore())).toThrow("EACCES");
  });

  it("re-throws disk I/O errors (EIO)", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockImplementation(() => {
      const err = new Error("EIO: i/o error") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    });
    expect(() => addIgnoreRules("/root", "/root", ignore())).toThrow("EIO");
  });

  it("loads and applies rules from an existing .gitignore file", () => {
    existsSyncMock.mockImplementation((p) => path.basename(String(p)) === ".gitignore");
    readFileSyncMock.mockReturnValue("*.log\n");
    const ig = ignore();
    addIgnoreRules("/root/sub", "/root", ig);
    expect(ig.ignores("sub/app.log")).toBe(true);
  });
});
