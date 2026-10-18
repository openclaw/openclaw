// Covers the private browser handoff for credential-bearing dashboard URLs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const { openLocalFileMock, createPrivateWindowsDirectoryMock, createPrivateWindowsFileMock } =
  vi.hoisted(() => ({
    openLocalFileMock: vi.fn<(filePath: string) => Promise<boolean>>(),
    createPrivateWindowsDirectoryMock: vi.fn<(directoryPath: string) => void>(),
    createPrivateWindowsFileMock: vi.fn(),
  }));

vi.mock("./browser-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-open.js")>()),
  openLocalFile: openLocalFileMock,
}));

vi.mock("./windows-private-directory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./windows-private-directory.js")>();
  createPrivateWindowsDirectoryMock.mockImplementation(actual.createPrivateWindowsDirectory);
  createPrivateWindowsFileMock.mockImplementation(actual.createPrivateWindowsFile);
  return {
    ...actual,
    createPrivateWindowsDirectory: createPrivateWindowsDirectoryMock,
    createPrivateWindowsFile: createPrivateWindowsFileMock,
  };
});

let openUrlPrivately: typeof import("./browser-handoff.js").openUrlPrivately;

beforeEach(async () => {
  vi.resetModules();
  ({ openUrlPrivately } = await import("./browser-handoff.js"));
  openLocalFileMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  // Remove only the handoff directories this test created (recorded from the
  // paths handed to the opener), never other processes' handoffs.
  const created = openLocalFileMock.mock.calls.map(([filePath]) => path.dirname(filePath));
  await Promise.all(
    created.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

const isPosix = process.platform !== "win32";

describe("openUrlPrivately", () => {
  it("hands the browser a private file path instead of the credential URL", async () => {
    const targetUrl = "http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token";

    await expect(openUrlPrivately(targetUrl)).resolves.toBe(true);

    expect(openLocalFileMock).toHaveBeenCalledTimes(1);
    const openedPath = openLocalFileMock.mock.calls[0]![0];
    // The opener argument must not contain the credential.
    expect(openedPath).not.toContain("secret-handoff-token");
    expect(openedPath).not.toContain(targetUrl);
    expect(path.isAbsolute(openedPath)).toBe(true);

    // The handoff document lives in a private directory and carries the URL.
    const dir = path.dirname(openedPath);
    const dirStat = await fs.stat(dir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(path.dirname(dir)).toBe(path.resolve(resolvePreferredOpenClawTmpDir()));
    expect(path.basename(dir)).toMatch(/^openclaw-browser-handoff-/);
    if (isPosix) {
      // POSIX owner-only permissions. Windows does not expose these mode
      // bits; there the per-user temp directory's ACL is the boundary.
      expect((dirStat.mode & 0o777).toString(8)).toBe("700");
      const fileStat = await fs.stat(openedPath);
      expect((fileStat.mode & 0o777).toString(8)).toBe("600");
    }
    const content = await fs.readFile(openedPath, "utf8");
    expect(content).toContain(encodeURIComponent("secret-handoff-token"));
    expect(content).toContain('location.replace("http://127.0.0.1:18789/#bootstrapToken=');
  });

  it.runIf(process.platform !== "win32")(
    "creates the Windows handoff through owner-only ACL helpers instead of POSIX modes",
    async () => {
      const realMkdir = (await import("node:fs")).mkdirSync;
      const realOpen = (await import("node:fs")).openSync;
      const realClose = (await import("node:fs")).closeSync;
      createPrivateWindowsDirectoryMock.mockImplementation((dir) => {
        realMkdir(dir, { mode: 0o700 });
      });
      createPrivateWindowsFileMock.mockImplementation((filePath: string) => {
        const fd = realOpen(filePath, "wx", 0o600);
        return { fd, close: () => realClose(fd), [Symbol.dispose]: () => realClose(fd) };
      });
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      try {
        await expect(
          openUrlPrivately("http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token"),
        ).resolves.toBe(true);
      } finally {
        platform.mockRestore();
      }

      const openedPath = openLocalFileMock.mock.calls[0]![0];
      expect(createPrivateWindowsDirectoryMock).toHaveBeenCalledWith(path.dirname(openedPath));
      expect(createPrivateWindowsFileMock).toHaveBeenCalledWith(openedPath);
      expect(await fs.readFile(openedPath, "utf8")).toContain("location.replace(");
    },
  );

  it("rejects non-http(s) targets without creating a handoff", async () => {
    await expect(openUrlPrivately("file:///etc/passwd")).resolves.toBe(false);
    expect(openLocalFileMock).not.toHaveBeenCalled();
  });

  it("removes the handoff when the browser opener reports failure", async () => {
    openLocalFileMock.mockResolvedValue(false);

    await expect(
      openUrlPrivately("http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token"),
    ).resolves.toBe(false);

    const openedPath = openLocalFileMock.mock.calls[0]?.[0];
    expect(openedPath).toBeDefined();
    await expect(fs.stat(openedPath!)).rejects.toThrow();
    await expect(fs.stat(path.dirname(openedPath!))).rejects.toThrow();
  });

  it("removes the handoff when the browser opener throws", async () => {
    openLocalFileMock.mockRejectedValue(new Error("opener failed"));

    await expect(
      openUrlPrivately("http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token"),
    ).resolves.toBe(false);

    const openedPath = openLocalFileMock.mock.calls[0]?.[0];
    await expect(fs.stat(path.dirname(openedPath!))).rejects.toThrow();
  });

  it("escapes the target URL inside the handoff document", async () => {
    const targetUrl = 'http://127.0.0.1:18789/#bootstrapToken=a"b<c>&x';
    await expect(openUrlPrivately(targetUrl)).resolves.toBe(true);

    const openedPath = openLocalFileMock.mock.calls[0]![0];
    const content = await fs.readFile(openedPath, "utf8");
    const normalized = new URL(targetUrl).toString();
    // URL normalization percent-encodes quotes and angle brackets in the
    // fragment before the document is built, and the attribute context
    // HTML-escapes ampersands — no tag breakout is possible.
    expect(normalized).toContain("a%22b%3Cc%3E");
    expect(content).toContain("a%22b%3Cc%3E");
    expect(content).toContain(`url=${normalized.replaceAll("&", "&amp;")}`);
    expect(content).toContain(`location.replace(${JSON.stringify(normalized)})`);
    expect(content).not.toContain('a"b<c>');
  });
});
