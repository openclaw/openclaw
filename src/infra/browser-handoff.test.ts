import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openUrlPrivately } from "./browser-handoff.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import * as windowsPrivate from "./windows-private-directory.js";

const { openLocalFileMock } = vi.hoisted(() => ({
  openLocalFileMock: vi.fn<(filePath: string) => Promise<boolean>>(),
}));

vi.mock("./browser-open.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-open.js")>()),
  openLocalFile: openLocalFileMock,
}));

const targetUrl = 'http://127.0.0.1:18789/#bootstrapToken=secret-handoff-token&a"b<c>&x';
const openedPath = () => openLocalFileMock.mock.calls[0]![0];

beforeEach(() => {
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

  const dir = path.dirname(file);
  const dirStat = await fs.stat(dir);
  expect(path.dirname(dir)).toBe(path.resolve(resolvePreferredOpenClawTmpDir()));
  expect(path.basename(dir)).toMatch(/^openclaw-browser-handoff-/);
  if (process.platform !== "win32") {
    expect((dirStat.mode & 0o777).toString(8)).toBe("700");
    const fileStat = await fs.stat(file);
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  }
  const content = await fs.readFile(file, "utf8");
  const normalized = new URL(targetUrl).toString();
  expect(content).toContain(`url=${normalized.replaceAll("&", "&amp;")}`);
  expect(content).toContain(`location.replace(${JSON.stringify(normalized)})`);
  expect(content).not.toContain('a"b<c>');
});

it.runIf(process.platform !== "win32")(
  "creates Windows handoffs with owner-only ACL helpers",
  async () => {
    using privateDirectory = vi
      .spyOn(windowsPrivate, "createPrivateWindowsDirectory")
      .mockImplementation((dir) => {
        fsSync.mkdirSync(dir, { mode: 0o700 });
      });
    using privateFile = vi
      .spyOn(windowsPrivate, "createPrivateWindowsFile")
      .mockImplementation((filePath) => {
        const fd = fsSync.openSync(filePath, "wx", 0o600);
        const close = () => fsSync.closeSync(fd);
        return { fd, close, [Symbol.dispose]: close };
      });
    using _ = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await expect(openUrlPrivately(targetUrl)).resolves.toBe(true);
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
