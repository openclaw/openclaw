import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

const { openLocalFileMock, privateDirectory, privateFile } = vi.hoisted(() => ({
  openLocalFileMock: vi.fn<(filePath: string) => Promise<boolean>>(),
  privateDirectory: vi.fn<(directoryPath: string) => void>(),
  privateFile: vi.fn(),
}));

vi.mock("./browser-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-open.js")>()),
  openLocalFile: openLocalFileMock,
}));

vi.mock("./windows-private-directory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./windows-private-directory.js")>();
  privateDirectory.mockImplementation(actual.createPrivateWindowsDirectory);
  privateFile.mockImplementation(actual.createPrivateWindowsFile);
  return {
    ...actual,
    createPrivateWindowsDirectory: privateDirectory,
    createPrivateWindowsFile: privateFile,
  };
});

let openUrlPrivately: typeof import("./browser-handoff.js").openUrlPrivately;
const targetUrl = 'http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token&a"b<c>&x';
const openedPath = () => openLocalFileMock.mock.calls[0]![0];

beforeEach(async () => {
  vi.resetModules();
  ({ openUrlPrivately } = await import("./browser-handoff.js"));
  openLocalFileMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  // Remove only handoffs this test passed to the opener.
  const created = openLocalFileMock.mock.calls.map(([filePath]) => path.dirname(filePath));
  await Promise.all(
    created.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

it("hands the browser a private file path instead of the credential URL", async () => {
  await expect(openUrlPrivately(targetUrl)).resolves.toBe(true);

  expect(openLocalFileMock).toHaveBeenCalledTimes(1);
  const file = openedPath();
  expect(file).not.toContain("secret-handoff-token");
  expect(path.isAbsolute(file)).toBe(true);

  const dir = path.dirname(file);
  const dirStat = await fs.stat(dir);
  expect(dirStat.isDirectory()).toBe(true);
  expect(path.dirname(dir)).toBe(path.resolve(resolvePreferredOpenClawTmpDir()));
  expect(path.basename(dir)).toMatch(/^openclaw-browser-handoff-/);
  if (process.platform !== "win32") {
    expect((dirStat.mode & 0o777).toString(8)).toBe("700");
    const fileStat = await fs.stat(file);
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  }
  const content = await fs.readFile(file, "utf8");
  const normalized = new URL(targetUrl).toString();
  expect(content).toContain("a%22b%3Cc%3E");
  expect(content).toContain(`url=${normalized.replaceAll("&", "&amp;")}`);
  expect(content).toContain(`location.replace(${JSON.stringify(normalized)})`);
  expect(content).not.toContain('a"b<c>');
});

it.runIf(process.platform !== "win32")(
  "creates Windows handoffs with owner-only ACL helpers",
  async () => {
    privateDirectory.mockImplementation((dir) => {
      fsSync.mkdirSync(dir, { mode: 0o700 });
    });
    privateFile.mockImplementation((filePath: string) => {
      const fd = fsSync.openSync(filePath, "wx", 0o600);
      const close = () => fsSync.closeSync(fd);
      return { fd, close, [Symbol.dispose]: close };
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await expect(openUrlPrivately(targetUrl)).resolves.toBe(true);
    } finally {
      platform.mockRestore();
    }

    const file = openedPath();
    expect(privateDirectory).toHaveBeenCalledWith(path.dirname(file));
    expect(privateFile).toHaveBeenCalledWith(file);
    expect(await fs.readFile(file, "utf8")).toContain("location.replace(");
  },
);

it("rejects non-http(s) targets without creating a handoff", async () => {
  await expect(openUrlPrivately("file:///etc/passwd")).resolves.toBe(false);
  expect(openLocalFileMock).not.toHaveBeenCalled();
});

it.each(["returns false", "throws"])("removes the handoff when the opener %s", async (failure) => {
  if (failure === "throws") {
    openLocalFileMock.mockRejectedValue(new Error("opener failed"));
  } else {
    openLocalFileMock.mockResolvedValue(false);
  }

  await expect(openUrlPrivately(targetUrl)).resolves.toBe(false);
  const file = openedPath();
  expect(file).toBeDefined();
  await expect(fs.stat(file)).rejects.toThrow();
  await expect(fs.stat(path.dirname(file))).rejects.toThrow();
});
