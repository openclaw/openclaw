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

let canUseBoundaryFileOpen: typeof import("./boundary-file-read.js").canUseBoundaryFileOpen;
let describeBoundaryFileOpenFailure: typeof import("./boundary-file-read.js").describeBoundaryFileOpenFailure;
let matchBoundaryFileOpenFailure: typeof import("./boundary-file-read.js").matchBoundaryFileOpenFailure;
let openBoundaryFile: typeof import("./boundary-file-read.js").openBoundaryFile;
let openBoundaryFileSync: typeof import("./boundary-file-read.js").openBoundaryFileSync;

describe("boundary-file-read", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      canUseBoundaryFileOpen,
      describeBoundaryFileOpenFailure,
      matchBoundaryFileOpenFailure,
      openBoundaryFile,
      openBoundaryFileSync,
    } = await import("./boundary-file-read.js"));
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
    };

    expect(canUseBoundaryFileOpen(validFs as never)).toBe(true);
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

  it("matches boundary file failures by reason with fallback support", () => {
    const missing = matchBoundaryFileOpenFailure(
      { ok: false, reason: "path", error: new Error("missing") },
      {
        path: () => "missing",
        fallback: () => "fallback",
      },
    );
    const io = matchBoundaryFileOpenFailure(
      { ok: false, reason: "io", error: new Error("io") },
      {
        io: () => "io",
        fallback: () => "fallback",
      },
    );
    const validation = matchBoundaryFileOpenFailure(
      { ok: false, reason: "validation", error: new Error("blocked") },
      {
        fallback: (failure) => failure.reason,
      },
    );

    expect(missing).toBe("missing");
    expect(io).toBe("io");
    expect(validation).toBe("validation");
  });

  it("describes ENOENT path failures as file-not-found", () => {
    const error = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    const msg = describeBoundaryFileOpenFailure(
      { ok: false, reason: "path", error },
      "./src/channel.js",
    );
    expect(msg).toBe("plugin entry file not found: ./src/channel.js");
  });

  it("describes non-ENOENT path failures with the error code", () => {
    const error = Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
    const msg = describeBoundaryFileOpenFailure(
      { ok: false, reason: "path", error },
      "./src/channel.js",
    );
    expect(msg).toBe("plugin entry path error (ENOTDIR): ./src/channel.js");
  });

  it("describes validation failures as boundary escape", () => {
    const msg = describeBoundaryFileOpenFailure(
      { ok: false, reason: "validation", error: new Error("outside root") },
      "../escaped.js",
    );
    expect(msg).toContain("escapes plugin root");
    expect(msg).toContain("../escaped.js");
  });

  it("describes io failures with the underlying error", () => {
    const msg = describeBoundaryFileOpenFailure(
      { ok: false, reason: "io", error: new Error("EACCES") },
      "./src/entry.js",
    );
    expect(msg).toContain("I/O error");
    expect(msg).toContain("./src/entry.js");
  });
});
