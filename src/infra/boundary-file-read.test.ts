import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveBoundaryPathSyncMock = vi.hoisted(() => vi.fn());
const resolveBoundaryPathMock = vi.hoisted(() => vi.fn());
const openVerifiedFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("./boundary-path.js", () => ({
  resolveBoundaryPathSync: (...args: unknown[]) => resolveBoundaryPathSyncMock(...args),
  resolveBoundaryPath: (...args: unknown[]) => resolveBoundaryPathMock(...args),
}));

vi.mock("./safe-open-sync.js", () => ({
  openVerifiedFileSync: (...args: unknown[]) => openVerifiedFileSyncMock(...args),
}));

const { canUseBoundaryFileOpen, openBoundaryFile, openBoundaryFileSync } =
  await import("./boundary-file-read.js");

describe("boundary-file-read", () => {
  beforeEach(() => {
    resolveBoundaryPathSyncMock.mockReset();
    resolveBoundaryPathMock.mockReset();
    openVerifiedFileSyncMock.mockReset();
  });

  it("recognizes the required sync fs surface", () => {
    const validFs = {
      openSync() {},
      closeSync() {},
      fstatSync() {},
      lstatSync() {},
      realpathSync() {},
      readFileSync() {},
      constants: {},
    } as never;

    expect(canUseBoundaryFileOpen(validFs)).toBe(true);
    expect(
      canUseBoundaryFileOpen({
        ...validFs,
        openSync: undefined,
      } as never),
    ).toBe(false);
    expect(
      canUseBoundaryFileOpen({
        ...validFs,
        constants: null,
      } as never),
    ).toBe(false);
  });

  it("maps sync boundary resolution into verified file opens", () => {
    const stat = { size: 3 } as never;
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("plugin.json");

    resolveBoundaryPathSyncMock.mockReturnValue({
      canonicalPath: "/real/plugin.json",
      rootCanonicalPath: "/real/root",
    });
    openVerifiedFileSyncMock.mockReturnValue({
      ok: true,
      path: "/real/plugin.json",
      fd: 7,
      stat,
    });

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
      ioFs,
    });

    expect(resolveBoundaryPathSyncMock).toHaveBeenCalledWith({
      absolutePath,
      rootPath: "/workspace",
      rootCanonicalPath: undefined,
      boundaryLabel: "plugin root",
      skipLexicalRootCheck: undefined,
    });
    expect(openVerifiedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/plugin.json",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
    });
    expect(opened).toEqual({
      ok: true,
      path: "/real/plugin.json",
      fd: 7,
      stat,
      rootRealPath: "/real/root",
    });
  });

  it("returns validation errors when sync boundary resolution throws", () => {
    const error = new Error("outside root");
    resolveBoundaryPathSyncMock.mockImplementation(() => {
      throw error;
    });

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
    });

    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error,
    });
    expect(openVerifiedFileSyncMock).not.toHaveBeenCalled();
  });

  it("guards against unexpected async sync-resolution results", () => {
    resolveBoundaryPathSyncMock.mockReturnValue(
      Promise.resolve({
        canonicalPath: "/real/plugin.json",
        rootCanonicalPath: "/real/root",
      }),
    );

    const opened = openBoundaryFileSync({
      absolutePath: "plugin.json",
      rootPath: "/workspace",
      boundaryLabel: "plugin root",
    });

    expect(opened.ok).toBe(false);
    if (opened.ok) {
      return;
    }
    expect(opened.reason).toBe("validation");
    expect(String(opened.error)).toContain("Unexpected async boundary resolution");
  });

  it("awaits async boundary resolution before verifying the file", async () => {
    const ioFs = { marker: "io" } as never;
    const absolutePath = path.resolve("notes.txt");

    resolveBoundaryPathMock.mockResolvedValue({
      canonicalPath: "/real/notes.txt",
      rootCanonicalPath: "/real/root",
    });
    openVerifiedFileSyncMock.mockReturnValue({
      ok: false,
      reason: "validation",
      error: new Error("blocked"),
    });

    const opened = await openBoundaryFile({
      absolutePath: "notes.txt",
      rootPath: "/workspace",
      boundaryLabel: "workspace",
      aliasPolicy: { allowFinalSymlinkForUnlink: true },
      ioFs,
    });

    expect(resolveBoundaryPathMock).toHaveBeenCalledWith({
      absolutePath,
      rootPath: "/workspace",
      rootCanonicalPath: undefined,
      boundaryLabel: "workspace",
      policy: { allowFinalSymlinkForUnlink: true },
      skipLexicalRootCheck: undefined,
    });
    expect(openVerifiedFileSyncMock).toHaveBeenCalledWith({
      filePath: absolutePath,
      resolvedPath: "/real/notes.txt",
      rejectHardlinks: true,
      maxBytes: undefined,
      allowedType: undefined,
      ioFs,
    });
    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error: expect.any(Error),
    });
  });

  it("maps async boundary resolution failures to validation errors", async () => {
    const error = new Error("escaped");
    resolveBoundaryPathMock.mockRejectedValue(error);

    const opened = await openBoundaryFile({
      absolutePath: "notes.txt",
      rootPath: "/workspace",
      boundaryLabel: "workspace",
    });

    expect(opened).toEqual({
      ok: false,
      reason: "validation",
      error,
    });
    expect(openVerifiedFileSyncMock).not.toHaveBeenCalled();
  });
});
