import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    throw new Error("should not be called");
  }),
  ensurePageState: vi.fn(() => ({
    console: [],
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  })),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => {
    throw new Error("should not be called");
  }),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", () => sessionMocks);

async function importModule() {
  return await import("./pw-tools-core.js");
}

describe("sanitizeDownloadFilename", () => {
  beforeEach(() => {
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
  });

  it("passes through a normal filename unchanged", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("report.pdf")).toBe("report.pdf");
  });

  it("strips directory traversal sequences", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("../../../etc/passwd")).toBe("passwd");
  });

  it("strips deep traversal with mixed separators", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("..\\..\\..\\windows\\system32\\config")).toBe("config");
  });

  it("handles a filename that is only dots and slashes", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("../../../")).toBe("download.bin");
  });

  it("handles double-dot without slashes", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    // path.basename("..") returns ".." which is a traversal token → fallback
    expect(sanitizeDownloadFilename("..")).toBe("download.bin");
  });

  it("handles single dot", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename(".")).toBe("download.bin");
  });

  it("strips null bytes from the filename", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("file\0name.txt")).toBe("filename.txt");
  });

  it("falls back to download.bin for empty input", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("")).toBe("download.bin");
  });

  it("falls back to download.bin for whitespace-only input", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("   ")).toBe("download.bin");
  });

  it("preserves filenames with dots that aren't traversal", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    expect(sanitizeDownloadFilename("my.report.2026.pdf")).toBe("my.report.2026.pdf");
  });

  it("preserves legitimate filenames containing double dots", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    // Filenames like "my..notes.txt" are valid and should not be mangled
    expect(sanitizeDownloadFilename("my..notes.txt")).toBe("my..notes.txt");
  });

  it("handles traversal embedded in a path but preserves the final basename", async () => {
    const { sanitizeDownloadFilename } = await importModule();
    // path.basename extracts "..ssh" — this is a valid filename, not a traversal
    const result = sanitizeDownloadFilename("foo/bar/../..ssh");
    expect(result).toBe("..ssh");
  });
});
