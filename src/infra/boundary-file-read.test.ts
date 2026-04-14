import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let describePluginBoundaryFileOpenFailure: typeof import("./boundary-file-read.js").describePluginBoundaryFileOpenFailure;
let matchBoundaryFileOpenFailure: typeof import("./boundary-file-read.js").matchBoundaryFileOpenFailure;
let openBoundaryFile: typeof import("./boundary-file-read.js").openBoundaryFile;
let openBoundaryFileSync: typeof import("./boundary-file-read.js").openBoundaryFileSync;

describe("boundary-file-read", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      canUseBoundaryFileOpen,
      describePluginBoundaryFileOpenFailure,
      matchBoundaryFileOpenFailure,
      openBoundaryFile,
      openBoundaryFileSync,
    } = await import("./boundary-file-read.js"));
  });

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

  it("describePluginBoundaryFileOpenFailure labels missing files vs boundary escape", () => {
    const missingError = Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" });
    const loopError = Object.assign(new Error("ELOOP: loop"), { code: "ELOOP" });

    expect(
      describePluginBoundaryFileOpenFailure(
        { ok: false, reason: "path", error: missingError },
        { entryPath: "./src/channel.js" },
      ),
    ).toContain("file not found in build output");
    expect(
      describePluginBoundaryFileOpenFailure(
        { ok: false, reason: "path", error: loopError },
        { entryPath: "./src/channel.js" },
      ),
    ).toContain("path could not be opened");
    expect(
      describePluginBoundaryFileOpenFailure(
        { ok: false, reason: "validation", error: new Error("outside") },
        { entryPath: "/tmp/x" },
      ),
    ).toContain("escapes plugin root");
    expect(
      describePluginBoundaryFileOpenFailure(
        { ok: false, reason: "io", error: new Error("EACCES: denied") },
        { entryPath: "./src/channel.js" },
      ),
    ).toContain("read failed");
  });
});
