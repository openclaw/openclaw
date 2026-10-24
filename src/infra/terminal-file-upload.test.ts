import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MAX_TERMINAL_UPLOAD_BYTES,
  isCanonicalTerminalUploadBase64,
} from "../../packages/gateway-protocol/src/schema/terminal-constants.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureTerminalUploadCleanup, stageTerminalUpload } from "./terminal-file-upload.js";

vi.mock("node:os", { spy: true });

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lstatMock = vi.mocked(fs.lstat);
const rmMock = vi.mocked(fs.rm);
const writeMock = vi.mocked(fs.writeFile);
const storageLimitBytes = 256 * 1024 * 1024;
const directoryLimit = 64;

async function makeUpload(directory: string, content: string, mtime?: number) {
  await fs.mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, "retained.bin");
  await fs.writeFile(file, content);
  if (mtime !== undefined) {
    await fs.utimes(directory, new Date(mtime), new Date(mtime));
  }
  return file;
}
async function createUploads(root: string, sizes: number[] | number, bytes = 0) {
  const byteSizes = typeof sizes === "number" ? Array<number>(sizes).fill(bytes) : sizes;
  return Promise.all(
    byteSizes.map(async (size, index) => {
      const directory = path.join(root, `openclaw-terminal-upload-retained-${index}`);
      const file = await makeUpload(directory, "");
      if (size > 0) {
        await fs.truncate(file, size);
      }
      return file;
    }),
  );
}

async function uploadLock(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const locks = entries.filter(
    (entry) => entry.isDirectory() && entry.name === "terminal-upload-lock",
  );
  expect(locks).toHaveLength(1);
  const lock = locks[0]!;
  return path.join(lock.parentPath, lock.name);
}

async function retainedDirectories(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("openclaw-terminal-upload-"))
    .map((entry) => entry.name);
}

async function advanceUploadCleanup(root: string, ms: number): Promise<void> {
  const completed = createDeferredCore();
  const remove = rmMock.getMockImplementation()!;
  rmMock.mockImplementation((target, options) => {
    if (path.dirname(String(target)) === root) {
      // Observe timer-driven removal before joining recovery. Deletion alone
      // precedes scan completion and lock release, stranding retries on fake time.
      completed.resolve(ensureTerminalUploadCleanup({ tempRoot: root }));
    }
    return remove(target, options);
  });
  try {
    await vi.advanceTimersByTimeAsync(ms);
    await completed.promise;
  } finally {
    rmMock.mockImplementation(remove);
  }
}

let root: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-terminal-upload-test-");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(os.homedir).mockReset();
  vi.mocked(os.tmpdir).mockReset();
  lstatMock.mockImplementation(actualFs.lstat);
  rmMock.mockImplementation(actualFs.rm);
  writeMock.mockImplementation(actualFs.writeFile);
  vi.useRealTimers();
});
function stage(name: string, contentBase64 = "") {
  return stageTerminalUpload({ name, contentBase64 }, { tempRoot: root });
}
it("stages arbitrary bytes under a private temporary directory", async () => {
  const content = Buffer.from([0, 1, 2, 255]);
  const result = await stage("../report final.pdf", content.toString("base64"));
  expect(path.basename(result.path)).toBe("report final.pdf");
  expect(result.path.startsWith(`${root}${path.sep}`)).toBe(true);
  expect(result.size).toBe(content.length);
  expect(await fs.readFile(result.path)).toEqual(content);
  if (process.platform !== "win32") {
    expect((await fs.stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(result.path))).mode & 0o777).toBe(0o700);
  }
});

it("uses the user-profile ACL boundary instead of a configurable Windows temp directory", async () => {
  const homeDir = tempDirs.make("openclaw-terminal-upload-windows-home-");
  const sharedTemp = tempDirs.make("openclaw-terminal-upload-windows-shared-");
  vi.mocked(os.homedir).mockReturnValue(homeDir);
  vi.mocked(os.tmpdir).mockReturnValue(sharedTemp);
  const result = await stageTerminalUpload(
    { name: "report.pdf", contentBase64: "" },
    { platform: "win32" },
  );
  expect(result.path.startsWith(path.join(homeDir, ".openclaw", "tmp"))).toBe(true);
  expect(result.path.startsWith(sharedTemp)).toBe(false);
});

it.each([
  { name: "an empty lock", payload: "" },
  { name: "an orphaned reclaim guard", payload: null },
])("protects shared-root locks and recovers safely from $name", async ({ payload }) => {
  if (process.platform !== "win32") {
    await fs.chmod(root, 0o1777);
  }
  const initial = await stage("accepted.bin", "AA==");
  const lockDirectory = await uploadLock(root);
  if (process.platform !== "win32") {
    expect((await fs.stat(root)).mode & 0o7777).toBe(0o1777);
    expect((await fs.stat(path.dirname(lockDirectory))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(lockDirectory)).mode & 0o777).toBe(0o700);
  }
  const lockPath = path.join(lockDirectory, "admission.lock");
  if (payload === null) {
    await fs.mkdir(`${lockPath}.reclaim`, { mode: 0o700 });
  } else {
    await fs.writeFile(lockPath, payload, { flag: "wx", mode: 0o600 });
  }
  const failure = await stage("blocked.bin", "AA==").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ message: expect.not.stringContaining(lockDirectory) });
  for (const message of [
    "Stop all Gateway and node-host processes",
    path.relative(root, lockDirectory),
    "remove only this lock directory",
    process.platform === "win32"
      ? "home directory of the account running this terminal's Gateway or node host"
      : "system temporary directory used by this terminal's Gateway or node-host process",
    "then restart them",
  ]) {
    expect(failure).toMatchObject({ message: expect.stringContaining(message) });
  }
  expect(await retainedDirectories(root)).toHaveLength(1);
  expect(await fs.readFile(initial.path)).toEqual(Buffer.from([0]));
  if (payload === null) {
    expect((await fs.stat(`${lockPath}.reclaim`)).isDirectory()).toBe(true);
  } else {
    expect(await fs.readFile(lockPath, "utf8")).toBe(payload);
  }
  await fs.rm(lockDirectory, { recursive: true, force: true });
  const recovered = await stage("after-recovery.bin", "AQ==");
  expect(await fs.readFile(recovered.path)).toEqual(Buffer.from([1]));
  expect(await fs.readFile(initial.path)).toEqual(Buffer.from([0]));
  expect(await retainedDirectories(root)).toHaveLength(2);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retries a finished upload's lock release after directory permissions recover",
  async () => {
    let lockDirectory = "";
    let writtenPath = "";
    writeMock.mockImplementation(async (target, data, options) => {
      await actualFs.writeFile(target, data, options);
      if (typeof target !== "string" || path.basename(target) !== "first.bin") {
        return;
      }
      writtenPath = target;
      lockDirectory = await uploadLock(root);
      await fs.chmod(lockDirectory, 0o500);
    });
    try {
      await expect(stage("first.bin", "AA==")).rejects.toMatchObject({ code: "EACCES" });
      expect(await fs.readFile(writtenPath)).toEqual(Buffer.from([0]));

      writeMock.mockImplementation(actualFs.writeFile);
      await fs.chmod(lockDirectory, 0o700);
      const recovered = await stage("second.bin", "AQ==");

      expect(await fs.readFile(recovered.path)).toEqual(Buffer.from([1]));
      expect(await fs.readFile(writtenPath)).toEqual(Buffer.from([0]));
      expect(await retainedDirectories(root)).toHaveLength(2);
      await expect(fs.stat(path.join(lockDirectory, "admission.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      writeMock.mockImplementation(actualFs.writeFile);
      if (lockDirectory) {
        await fs.chmod(lockDirectory, 0o700);
      }
    }
  },
);

it("normalizes hostile and oversized names", async () => {
  const stagedName = async (name: string) => {
    const result = await stage(name, "ZmlsZQ==");
    expect(await fs.readFile(result.path, "utf8")).toBe("file");
    return path.basename(result.path);
  };
  expect(await stagedName("..\\..\\secret\u0000.txt")).toBe("secret.txt");
  expect(await stagedName("../evil/re<po|rt?.pdf")).toBe("report.pdf");
  expect(await stagedName("report:<final>?!-%PATH%.pdf. ")).toBe("reportfinal_-_PATH_.pdf");
  expect(await stagedName("CON")).toBe("CON_");
  expect(await stagedName("nul.txt")).toBe("nul_.txt");
  expect(await stagedName("aux.c")).toBe("aux_.c");
  expect(await stagedName("CON.txt")).toBe("CON_.txt");
  expect(await stagedName("COM¹.txt")).toBe("COM¹_.txt");
  expect(await stagedName("LPT³.log")).toBe("LPT³_.log");
  expect(Buffer.byteLength(await stagedName("🦞".repeat(100)), "utf8")).toBeLessThanOrEqual(180);
  expect(await stagedName(`${"a".repeat(179)}.b`)).toBe("a".repeat(179));
  expect(await stagedName(`${"b".repeat(179)} c`)).toBe("b".repeat(179));
  expect(await stagedName(`${"c".repeat(175)}🦞.d`)).toBe(`${"c".repeat(175)}🦞`);
  expect(await stagedName(`CON${" ".repeat(177)}x`)).toBe("CON_");
  expect(await stagedName("..")).toBe("upload");
  expect(await stagedName("  ..  ")).toBe("upload");
});

it("keeps the recovered expiry after renaming an over-budget set of upload directories", async () => {
  const count = directoryLimit + 1;
  vi.useFakeTimers({ now: Date.now() + 60_000 });
  const remainingMs = 2 * 60 * 60 * 1000;
  const files = await createUploads(root, count);
  const originalTime = new Date(Date.now() - 22 * 60 * 60 * 1000);
  await Promise.all(files.map((file) => fs.utimes(path.dirname(file), originalTime, originalTime)));
  await ensureTerminalUploadCleanup({ tempRoot: root });
  const renamed = files.map((file) => path.join(path.dirname(file), "renamed.bin"));
  await Promise.all(files.map((file, index) => fs.rename(file, renamed[index]!)));
  await vi.advanceTimersByTimeAsync(remainingMs - 1);
  expect(await retainedDirectories(root)).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(1);
  await advanceUploadCleanup(root, 1);
  expect(await retainedDirectories(root)).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("gives replacement directories their own expiry with 64-bit file identifiers", async () => {
  vi.useFakeTimers({ now: Date.now() + 60_000 });
  const directory = path.join(root, "openclaw-terminal-upload-replaced");
  const movedDirectory = path.join(root, "operator-kept");
  const retentionMs = 24 * 60 * 60 * 1000;
  const remainingMs = 2 * 60 * 60 * 1000;
  let inode = 2n ** 54n;
  lstatMock.mockImplementation(async (target, options) => {
    const stats = await actualFs.lstat(target, options);
    if (String(target) === directory) {
      stats.ino = typeof stats.ino === "bigint" ? inode : Number(inode);
    }
    return stats;
  });
  await makeUpload(directory, "original", Date.now() - retentionMs + remainingMs);
  await ensureTerminalUploadCleanup({ tempRoot: root });
  await fs.rename(directory, movedDirectory);
  inode += 1n;
  const replacementFile = await makeUpload(directory, "replacement", Date.now());
  await vi.advanceTimersByTimeAsync(remainingMs);
  await ensureTerminalUploadCleanup({ tempRoot: root });
  expect(await fs.readFile(replacementFile, "utf8")).toBe("replacement");
  await advanceUploadCleanup(root, retentionMs - remainingMs);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(path.join(movedDirectory, "retained.bin"), "utf8")).toBe("original");
});
it("expires a future-dated upload without extending retention on each recovery scan", async () => {
  const nowMs = Date.UTC(2026, 8, 7, 12);
  const retentionMs = 1_000;
  vi.useFakeTimers({ now: nowMs });
  const directory = path.join(root, "openclaw-terminal-upload-future");
  const retainedFile = await makeUpload(directory, "retained", nowMs + 2 ** 31 + retentionMs);
  await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs });
  expect((await fs.stat(directory)).mtimeMs).toBe(nowMs);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(retentionMs / 2);
  await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs });
  expect((await fs.stat(directory)).mtimeMs).toBe(nowMs);
  expect(await fs.readFile(retainedFile, "utf8")).toBe("retained");
  await advanceUploadCleanup(root, retentionMs / 2);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(retentionMs * 2);
  expect(vi.getTimerCount()).toBe(0);
});

it("admits only the last available directory across simultaneous uploads after restart", async () => {
  await createUploads(root, directoryLimit - 1);
  const results = await Promise.allSettled(["first.bin", "second.bin"].map((name) => stage(name)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  await expect(stage("overflow.bin")).rejects.toThrow();
  expect(await retainedDirectories(root)).toHaveLength(directoryLimit);
});

it("enforces the retained byte budget independently of the directory budget", async () => {
  const sizes = Array.from({ length: storageLimitBytes / MAX_TERMINAL_UPLOAD_BYTES }, (_, index) =>
    index === 0 ? MAX_TERMINAL_UPLOAD_BYTES - 1 : MAX_TERMINAL_UPLOAD_BYTES,
  );
  await createUploads(root, sizes);
  const lastByte = await stage("last-byte.bin", "AA==");
  expect(await fs.readFile(lastByte.path)).toEqual(Buffer.from([0]));
  await expect(stage("overflow.bin", "AA==")).rejects.toThrow();
  const empty = await stage("empty.bin");
  expect(await fs.readFile(empty.path)).toEqual(Buffer.alloc(0));
  expect(await retainedDirectories(root)).toHaveLength(sizes.length + 2);
});

it("keeps partially removed expired uploads charged and retries at the original deadline", async () => {
  vi.useFakeTimers({ now: Date.now() + 60_000 });
  const files = await createUploads(root, directoryLimit, storageLimitBytes / directoryLimit);
  const expiredFile = files[0]!;
  const expiredDirectory = path.dirname(expiredFile);
  const removableFile = path.join(expiredDirectory, "removed-before-failure.bin");
  await fs.writeFile(removableFile, "");
  await fs.utimes(expiredDirectory, new Date(0), new Date(0));
  rmMock.mockImplementation(async (target, options) => {
    if (String(target) === expiredDirectory) {
      await actualFs.rm(removableFile, { force: true });
      throw Object.assign(new Error("cleanup busy"), { code: "EBUSY" });
    }
    return actualFs.rm(target, options);
  });
  await ensureTerminalUploadCleanup({ tempRoot: root });
  await expect(stage("too-early.bin", "AA==")).rejects.toThrow();
  await expect(fs.stat(removableFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.stat(expiredDirectory)).mtimeMs).toBeGreaterThan(0);
  expect((await fs.stat(expiredFile)).size).toBe(storageLimitBytes / directoryLimit);
  expect(await retainedDirectories(root)).toHaveLength(directoryLimit);
  rmMock.mockImplementation(actualFs.rm);
  await advanceUploadCleanup(root, 60 * 60 * 1000);
  await expect(fs.stat(expiredDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  const accepted = await stage("after-cleanup.bin", "AA==");
  expect(await fs.readFile(accepted.path)).toEqual(Buffer.from([0]));
  expect(await retainedDirectories(root)).toHaveLength(directoryLimit);
});

it("does not treat an uninspectable retained file as free capacity", async () => {
  const files = await createUploads(
    root,
    storageLimitBytes / MAX_TERMINAL_UPLOAD_BYTES,
    MAX_TERMINAL_UPLOAD_BYTES,
  );
  let inspectionFailed = false;
  lstatMock.mockImplementation(async (target, options) => {
    if (String(target) === files[0]) {
      inspectionFailed = true;
      throw Object.assign(new Error("cannot inspect retained upload"), { code: "EACCES" });
    }
    return actualFs.lstat(target, options);
  });
  await expect(stage("unaccounted.bin", "AA==")).rejects.toThrow();
  expect(inspectionFailed).toBe(true);
  expect(await retainedDirectories(root)).toHaveLength(files.length);
  lstatMock.mockImplementation(actualFs.lstat);
  await expect(stage("full.bin", "AA==")).rejects.toThrow();
});

it("bounds cleanup timers for over-budget recovery and repeated external deletion", async () => {
  vi.useFakeTimers();
  const files = await createUploads(root, directoryLimit + 1);
  await ensureTerminalUploadCleanup({ tempRoot: root });
  expect(await retainedDirectories(root)).toHaveLength(directoryLimit + 1);
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  await expect(stage("over-budget.bin")).rejects.toThrow();
  await Promise.all(
    files.map((file) => fs.rm(path.dirname(file), { recursive: true, force: true })),
  );

  for (let index = 0; index < 3; index += 1) {
    const result = await stage("replacement.bin");
    expect(await fs.readFile(result.path)).toEqual(Buffer.alloc(0));
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    await fs.rm(path.dirname(result.path), { recursive: true, force: true });
  }
});

it("retries a recovery scan after a transient root failure", async () => {
  vi.useFakeTimers();
  const parent = tempDirs.make("openclaw-terminal-upload-retry-test-");
  root = path.join(parent, "root");
  const directory = path.join(root, "openclaw-terminal-upload-stale");
  await fs.writeFile(root, "temporarily not a directory");
  await ensureTerminalUploadCleanup({ tempRoot: root, retentionMs: 1 });
  await fs.rm(root);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, "report.pdf"), "stale");
  await fs.utimes(directory, new Date(0), new Date(0));
  await advanceUploadCleanup(root, 60 * 60 * 1000);
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries partial upload cleanup without replacing the write error", async () => {
  vi.useFakeTimers();
  const writeError = new Error("write failed");
  let partialFile = "";
  let failedRemoval = false;
  writeMock.mockImplementation(async (target, data, options) => {
    if (typeof target === "string" && path.basename(target) === "partial.bin") {
      partialFile = target;
      await actualFs.writeFile(target, data, options);
      throw writeError;
    }
    return actualFs.writeFile(target, data, options);
  });
  rmMock.mockImplementation(async (target, options) => {
    if (partialFile && String(target) === path.dirname(partialFile) && !failedRemoval) {
      failedRemoval = true;
      throw new Error("cleanup busy");
    }
    return actualFs.rm(target, options);
  });
  await expect(stage("partial.bin", "AA==")).rejects.toBe(writeError);
  expect(await fs.readFile(partialFile)).toEqual(Buffer.from([0]));
  await advanceUploadCleanup(root, 60 * 60 * 1000);
  await expect(fs.stat(path.dirname(partialFile))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects malformed and oversized payloads", async () => {
  expect(isCanonicalTerminalUploadBase64("AB==")).toBe(false);
  expect(isCanonicalTerminalUploadBase64("AAB=")).toBe(false);
  expect(isCanonicalTerminalUploadBase64("AA==")).toBe(true);
  await expect(stage("bad.bin", "not base64")).rejects.toThrow("invalid terminal upload encoding");
  await expect(
    stage("large.bin", Buffer.alloc(MAX_TERMINAL_UPLOAD_BYTES + 1).toString("base64")),
  ).rejects.toThrow("exceeds");
});
