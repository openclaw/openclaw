import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as fsSafe from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { MediaAttachmentCache } from "./attachments.js";
import { resolveMediaAttachmentLocalRoots } from "./runner.attachments.js";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
    readRemoteMediaBufferWithHeaders: readRemoteMediaBufferMock,
  };
});

vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: vi.fn(actual.resolvePreferredOpenClawTmpDir),
  };
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);
const request = { attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 };
const pngRequest = { ...request, maxBytes: PNG_1X1.length };
const remoteAttachment = { index: 0, url: "https://example.com/photo.png" };
const caches: MediaAttachmentCache[] = [];
const it = baseIt.extend<{ base: string }>({
  base: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-media-cache-" }, use);
  },
});
function createCache(...args: ConstructorParameters<typeof MediaAttachmentCache>) {
  const cache = new MediaAttachmentCache(...args);
  caches.push(cache);
  return cache;
}
function localCache(file: string, root: string, url?: string) {
  return createCache([{ index: 0, path: file, url }], {
    localPathRoots: [root],
    includeDefaultLocalPathRoots: false,
  });
}
function mockRemote(base: string, fileName = "photo.png") {
  vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
  readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName });
}
async function mediaFile(base: string, name: string, content: Buffer | string = PNG_1X1) {
  const file = path.join(base, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}
async function expectStaged(cache: MediaAttachmentCache, file: string) {
  await expect(fs.readFile(file)).resolves.toEqual(PNG_1X1);
  expect(await cache.getPath(request)).toBe(file);
}
async function expectZeroLimit(cache: MediaAttachmentCache, attachmentIndex = 0) {
  await expect(cache.getPath({ ...request, attachmentIndex, maxBytes: 0 })).rejects.toMatchObject({
    reason: "maxBytes",
  });
}
function failPartialWrite(beforeFailure = async () => {}) {
  const writeFile = fs.writeFile.bind(fs);
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const spy = vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file) => {
    await writeFile(file, PNG_1X1.subarray(0, 4));
    await beforeFailure();
    throw error;
  });
  return { error, spy };
}
const test = it.extend<{ cache: MediaAttachmentCache }>({
  cache: async ({ base }, use) => {
    mockRemote(base);
    const cache = createCache([remoteAttachment]);
    await use(cache);
    await cache.cleanup();
    expect(await fs.readdir(base)).toEqual([]);
  },
});

it.for(["canonical", "directory alias"] as const)(
  "keeps session-scoped roots authoritative for %s attachment paths",
  async (spelling, { base }) => {
    const stateDir = path.join(base, "state");
    const sessionWorkspaceDir = path.join(stateDir, "sandboxes", "session-a");
    const files = [
      await mediaFile(sessionWorkspaceDir, "own.txt", "OWN-SANDBOX-CONTENT"),
      await mediaFile(stateDir, "sandboxes/session-b/sibling.txt", "SIBLING-SANDBOX-CONTENT"),
      await mediaFile(stateDir, "workspace/host-secret.txt", "SHARED-HOST-WORKSPACE-CONTENT"),
    ];
    let sourceStateDir = stateDir;
    if (spelling === "directory alias") {
      sourceStateDir = path.join(base, "state-alias");
      await fs.symlink(stateDir, sourceStateDir, process.platform === "win32" ? "junction" : "dir");
    }
    const sourcePath = (file: string) => path.join(sourceStateDir, path.relative(stateDir, file));

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const roots = resolveMediaAttachmentLocalRoots({
        cfg: {} as never,
        ctx: {} as never,
        workspaceDir: sessionWorkspaceDir,
      });
      const cache = createCache(
        files.map((file, index) => ({ index, path: sourcePath(file) })),
        { localPathRoots: roots, includeDefaultLocalPathRoots: false },
      );

      const own = await cache.getBuffer(request);
      expect(own.buffer.toString()).toBe("OWN-SANDBOX-CONTENT");
      for (const attachmentIndex of [1, 2]) {
        await expect(cache.getBuffer({ ...request, attachmentIndex })).rejects.toThrow(
          /outside allowed roots/i,
        );
      }
    });
  },
);

it("rejects an alias retargeted outside the granted root before opening", async ({ base }) => {
  const allowedRoot = path.join(base, "allowed");
  const outsideRoot = path.join(base, "outside");
  const alias = path.join(base, "alias");
  await Promise.all(
    [allowedRoot, outsideRoot].map((root) => mediaFile(root, "note.txt", path.basename(root))),
  );
  const aliasType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(allowedRoot, alias, aliasType);
  const openLocalFileSafely = fsSafe.openLocalFileSafely;
  const openSpy = vi.spyOn(fsSafe, "openLocalFileSafely").mockImplementation(async (params) => {
    await fs.unlink(alias);
    await fs.symlink(outsideRoot, alias, aliasType);
    return await openLocalFileSafely(params);
  });
  const cache = localCache(path.join(alias, "note.txt"), allowedRoot);

  await expect(cache.getBuffer(request)).rejects.toMatchObject({ reason: "blocked" });
  expect(openSpy).toHaveBeenCalledOnce();
});

afterEach(async () => {
  for (const cache of caches.splice(0)) {
    await cache.cleanup();
  }
  vi.restoreAllMocks();
  vi.mocked(resolvePreferredOpenClawTmpDir).mockReset();
  readRemoteMediaBufferMock.mockReset();
});

it.for(["growing", "read-failure"] as const)(
  "closes one bounded local read when the file is %s",
  async (behavior, { base }) => {
    const attachmentPath = await mediaFile(base, "growing.png");
    const maxBytes = PNG_1X1.length;
    const open = fs.open.bind(fs);
    let consumed = 0;
    let opens = 0;
    let closes = 0;
    let grew = false;
    const readError = new Error("synthetic read failure");
    const growBeforeRead = async () => {
      if (behavior === "read-failure") {
        throw readError;
      }
      if (!grew) {
        grew = true;
        await fs.appendFile(attachmentPath, Buffer.alloc(4096));
      }
    };
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      opens += 1;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closes += 1;
        await close();
      });
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        await growBeforeRead();
        const result = await read(...readArgs);
        consumed += result.bytesRead;
        return result;
      });
      const readFile = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => {
        await growBeforeRead();
        const result = await readFile(...readArgs);
        consumed += result.length;
        return result;
      });
      return handle;
    });
    const cache = localCache(attachmentPath, base);

    const result = cache.getBuffer({ ...request, maxBytes });
    if (behavior === "growing") {
      await expect(result).rejects.toMatchObject({ reason: "maxBytes" });
    } else {
      await expect(result).rejects.toBe(readError);
    }
    expect({ opens, closes, consumed }).toEqual({
      opens: 1,
      closes: 1,
      consumed: behavior === "read-failure" ? 0 : maxBytes + Number(grew),
    });
  },
);

test.for([
  { fileName: "photo.png", extension: ".png", removeBeforeCleanup: false },
  { fileName: "photo.a:b", extension: ".b", removeBeforeCleanup: true },
])(
  "restages $fileName with a safe suffix after cache cleanup",
  async ({ fileName, extension, removeBeforeCleanup }, { base, cache }) => {
    readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName });
    const first = await cache.getPath(pngRequest);
    await expectZeroLimit(cache);
    expect(path.extname(first)).toBe(extension);
    if (removeBeforeCleanup) {
      await fs.unlink(first);
    }
    await cache.cleanup();
    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(base)).toEqual([]);
    const second = await cache.getPath(pngRequest);
    expect(second).not.toBe(first);
    expect(path.extname(second)).toBe(extension);
    await expectStaged(cache, second);
    expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(1);
  },
);

it("keeps local access lazy and borrowed bytes alive across cleanup", async ({ base }) => {
  vi.mocked(resolvePreferredOpenClawTmpDir).mockReturnValue(base);
  const localPath = await mediaFile(base, "photo.png");
  readRemoteMediaBufferMock.mockResolvedValue({
    buffer: PNG_1X1,
    fileName: "photo.png",
    contentType: "image/jpeg",
  });
  const cache = createCache(
    [
      { ...remoteAttachment, mime: "application/pdf" },
      { index: 1, path: localPath, mime: "application/octet-stream" },
    ],
    { localPathRoots: [base], includeDefaultLocalPathRoots: false },
  );
  expect(await cache.getPath({ ...pngRequest, attachmentIndex: 1 })).toBe(localPath);
  await expectZeroLimit(cache, 1);
  const borrowed = await cache.getBuffer(request);
  const local = await cache.getBuffer({ ...request, attachmentIndex: 1 });
  for (const result of [borrowed, local]) {
    expect(result.classification).toEqual({ mime: "image/png", class: "image" });
    expect(result.mime).toBe("image/png");
  }
  await cache.cleanup();
  expect(await fs.readdir(base)).toEqual(["photo.png"]);
  expect(resolvePreferredOpenClawTmpDir).not.toHaveBeenCalled();
  expect(await cache.getBuffer(request)).toBe(borrowed);
  cache.releaseBuffer(0);
  expect(await cache.getBuffer(request)).not.toBe(borrowed);
  expect(borrowed.buffer).toBe(PNG_1X1);
  expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(2);
});

it.for([false, true])(
  "does not return a local path after its validation open fails (URL fallback: %s)",
  async (hasFallback, { base }) => {
    mockRemote(base, "remote.png");
    const attachmentPath = await mediaFile(base, "local.png");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === attachmentPath) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await open(...args);
    });
    const cache = localCache(attachmentPath, base, hasFallback ? remoteAttachment.url : undefined);
    const result = cache.getPath(request);
    if (hasFallback) {
      const staged = await result;
      expect(staged).not.toBe(attachmentPath);
      await expect(fs.readFile(staged)).resolves.toEqual(PNG_1X1);
    } else {
      await expect(result).rejects.toMatchObject({ reason: "blocked" });
    }
    expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(Number(hasFallback));
  },
);

it.skipIf(process.platform === "win32")(
  "stages in a selector-approved fallback root and preserves unrelated files",
  async ({ base }) => {
    const preferredDir = path.join(base, "preferred-is-a-file");
    const fallbackParent = path.join(base, "shared-tmp");
    await fs.writeFile(preferredDir, "unavailable preferred directory");
    await fs.mkdir(fallbackParent);
    await fs.chmod(fallbackParent, 0o770);
    const actual = await vi.importActual<typeof import("../infra/tmp-openclaw-dir.js")>(
      "../infra/tmp-openclaw-dir.js",
    );
    vi.mocked(resolvePreferredOpenClawTmpDir).mockImplementation(() =>
      actual.resolvePreferredOpenClawTmpDir({ preferredDir, tmpdir: () => fallbackParent }),
    );
    const selectedRoot = resolvePreferredOpenClawTmpDir();
    await fs.writeFile(path.join(selectedRoot, "unrelated.txt"), "keep");
    readRemoteMediaBufferMock.mockResolvedValue({ buffer: PNG_1X1, fileName: "photo.png" });
    const cache = createCache([remoteAttachment], { includeDefaultLocalPathRoots: false });
    const staged = await cache.getPath(request);
    expect(path.dirname(staged)).toBe(selectedRoot);
    await expect(fs.readFile(staged)).resolves.toEqual(PNG_1X1);
    await cache.cleanup();
    expect(await fs.readdir(selectedRoot)).toEqual(["unrelated.txt"]);
    expect((await fs.stat(selectedRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(fallbackParent)).mode & 0o777).toBe(0o770);
  },
);

test("keeps concurrent staging success after a write failure", async ({ base, cache }) => {
  const started = createDeferred();
  const finish = createDeferred();
  const { error } = failPartialWrite(async () => {
    started.resolve();
    await finish.promise;
  });
  const failed = expect(cache.getPath(request)).rejects.toBe(error);
  try {
    await started.promise;
    const successful = await cache.getPath(request);
    finish.resolve();
    await failed;
    expect(await fs.readdir(base)).toEqual([path.basename(successful)]);
    await expectStaged(cache, successful);
  } finally {
    finish.resolve();
    await failed;
  }
});

test("retries failed cleanup across later staging success", async ({ base, cache }) => {
  const { error, spy } = failPartialWrite();
  const cleanupError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupError);

  await expect(cache.getPath(request)).rejects.toBe(error);
  expect(await fs.readdir(base)).toHaveLength(1);

  const staged = await cache.getPath(request);
  await expectStaged(cache, staged);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(base)).toHaveLength(2);

  unlink.mockRejectedValueOnce(cleanupError);
  await cache.cleanup();
  expect(await fs.readdir(base)).toHaveLength(1);

  await cache.cleanup();
  expect(await fs.readdir(base)).toEqual([]);
});

test("retains files staged after cleanup takes its snapshot", async ({ cache }) => {
  const first = await cache.getPath(request);
  const started = createDeferred();
  const finish = createDeferred();
  const unlink = fs.unlink.bind(fs);
  vi.spyOn(fs, "unlink").mockImplementationOnce(async (file) => {
    started.resolve();
    await finish.promise;
    await unlink(file);
  });
  const cleaning = cache.cleanup();
  try {
    await started.promise;
    const second = await cache.getPath(request);
    expect(second).not.toBe(first);
    finish.resolve();
    await cleaning;
    await expectStaged(cache, second);
  } finally {
    finish.resolve();
    await cleaning;
  }
});
