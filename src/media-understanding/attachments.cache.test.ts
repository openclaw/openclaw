import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { toInboundMediaFacts } from "../channels/inbound-event/media.js";
import type { OpenClawConfig } from "../config/types.js";
import * as fsSafe from "../infra/fs-safe.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import * as logger from "../logger.js";
import { saveMediaBuffer } from "../media/store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { applyMediaUnderstanding } from "./apply.js";
import { MediaAttachmentCache } from "./attachments.js";
import { resolveScopeDecision } from "./resolve.js";
import { resolveMediaAttachmentLocalRoots } from "./runner.attachments.js";
import { createSafeAudioFixtureBuffer } from "./runner.test-utils.js";

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
const it = baseIt.extend<{
  base: string;
  stateDir: string;
  saved: { id: string; path: string };
  realFetch: void;
}>({
  base: async ({ task: _task }, use) => {
    await withTestDir({ prefix: "openclaw-media-cache-" }, use);
  },
  stateDir: async ({ base }, use) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: base, PATH: "" }, () => use(base));
  },
  saved: async ({ stateDir: _stateDir }, use) => {
    await use(
      await saveMediaBuffer(createSafeAudioFixtureBuffer(2048, 0x52), "audio/ogg", "inbound"),
    );
  },
  realFetch: async ({ task: _task }, use) => {
    const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
    readRemoteMediaBufferMock.mockImplementation(actual.readRemoteMediaBufferWithHeaders);
    await use(undefined);
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
function download(text: string, mime: string) {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(text, { headers: { "content-type": mime } }));
  vi.spyOn(globalThis, "fetch").mockImplementation(withFetchPreconnect(fetch));
  return fetch;
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
const storeRequest = { ...request, maxBytes: 4096 };
function storedCache(saved: { id: string; path: string }, sourcePath: string) {
  return localCache(sourcePath, path.dirname(saved.path), `media://inbound/${saved.id}`);
}
const urlDisabledFileCfg: OpenClawConfig = {
  plugins: { enabled: false },
  tools: {
    media: { audio: { enabled: false }, image: { enabled: false }, video: { enabled: false } },
  },
  gateway: { http: { endpoints: { responses: { files: { allowUrl: false } } } } },
};
async function extractDocument(url: string, contentType: string) {
  const ctx: MsgContext = {
    Body: "<media:document>",
    media: toInboundMediaFacts([{ url, contentType, kind: "document" }]),
  };
  await applyMediaUnderstanding({ ctx, cfg: urlDisabledFileCfg });
  return ctx.Body;
}

it("extracts a stored document when remote URLs are disabled", async ({ stateDir: _stateDir }) => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const saved = await saveMediaBuffer(Buffer.from("stored document text"), "text/plain", "inbound");
  expect(await extractDocument(`media://inbound/${saved.id}`, "text/plain")).toContain(
    "stored document text",
  );
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
});
it("never renders signed URL query credentials as attachment names", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const body = await extractDocument(
    "https://cdn.example.test/docs/report.docx?X-Amz-Signature=SECRETSIG&X-Amz-Credential=AKIA123",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(body).toContain("[Attachment skipped: URL file sources are disabled]");
  expect(body).toContain('name="report.docx"');
  expect(body).not.toContain("SECRETSIG");
  expect(body).not.toContain("AKIA123");
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
});
it("prefers the media:// alias when the supplied path is blocked", async ({ saved, base }) => {
  const blocked = await mediaFile(base, "blocked.ogg", "blocked");
  expect((await storedCache(saved, blocked).getBuffer(storeRequest)).buffer).toEqual(
    createSafeAudioFixtureBuffer(2048, 0x52),
  );
  expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
});
it("returns the stored path after a stale path fails", async ({ saved }) => {
  const cache = storedCache(saved, `${saved.path}.missing`);
  expect(await cache.getPath(storeRequest)).toBe(await fs.realpath(saved.path));
  await cache.cleanup();
  expect((await fs.stat(saved.path)).isFile()).toBe(true);
});
it("does not bypass a path maxBytes failure through the media:// alias", async ({ saved }) => {
  const oversized = await mediaFile(
    path.dirname(saved.path),
    "oversized.ogg",
    createSafeAudioFixtureBuffer(8192, 0x41),
  );
  await expect(storedCache(saved, oversized).getBuffer(storeRequest)).rejects.toMatchObject({
    reason: "maxBytes",
  });
});
it("rejects malformed media:// aliases without attempting a remote fetch", async () => {
  const cache = createCache([{ index: 0, url: "media://inbound/%" }]);
  await expect(cache.getBuffer(storeRequest)).rejects.toMatchObject({ reason: "empty" });
  expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
});

it("matches channel chatType explicitly", () => {
  expect(
    resolveScopeDecision({
      scope: { rules: [{ action: "deny", match: { chatType: "channel" } }] },
      ctx: { ChatType: "channel" },
    }),
  ).toBe("deny");
});
it("allows RFC2544 benchmark-range URLs only when media fetch policy opts in", async ({
  realFetch: _realFetch,
}) => {
  const attachment = { index: 0, url: "http://198.18.0.153/file.jpg" };
  await expect(createCache([attachment]).getBuffer(request)).rejects.toThrow(
    /private|internal|blocked/i,
  );
  const fetchSpy = download("image", "image/jpeg");
  const cache = createCache([attachment], { ssrfPolicy: { allowRfc2544BenchmarkRange: true } });
  expect(await cache.getBuffer(request)).toStrictEqual({
    buffer: Buffer.from("image"),
    classification: { mime: "image/jpeg", class: "image" },
    mime: "image/jpeg",
    fileName: "file.jpg",
    size: 5,
  });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
it("carries no local path when a blocked path recovers through the URL fallback", async ({
  base,
  realFetch: _realFetch,
}) => {
  const blockedPath = await mediaFile(base, "outside-roots/report.doc", "blocked");
  download("remote-bytes", "application/msword");
  const cache = createCache(
    [{ index: 0, path: blockedPath, url: "http://198.18.0.153/report.doc" }],
    {
      localPathRoots: [path.join(base, "allowed-only")],
      includeDefaultLocalPathRoots: false,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    },
  );
  const result = await cache.getBuffer(request);
  expect(result.buffer.toString()).toBe("remote-bytes");
  expect(result.localPath).toBeUndefined();
});
it("resolves each relative attachment against its own workspace", async ({ base }) => {
  const workspaces = ["first", "second"].map((name) => path.join(base, name));
  await Promise.all(
    workspaces.map((dir, index) => mediaFile(dir, "attachment.txt", `slot-${index}`)),
  );
  const cache = createCache(
    workspaces.map((workspaceDir, index) => ({ index, path: "attachment.txt", workspaceDir })),
    { localPathRoots: workspaces },
  );
  await expect(
    Promise.all(
      workspaces.map((_, attachmentIndex) => cache.getBuffer({ ...request, attachmentIndex })),
    ),
  ).resolves.toEqual([
    expect.objectContaining({ buffer: Buffer.from("slot-0") }),
    expect.objectContaining({ buffer: Buffer.from("slot-1") }),
  ]);
});
it("resolves managed inbound media URI attachments", async ({ saved }) => {
  const cache = localCache(
    `media://inbound/${encodeURIComponent(saved.id)}`,
    path.dirname(saved.path),
  );
  const result = await cache.getBuffer(storeRequest);
  expect(result.buffer).toEqual(createSafeAudioFixtureBuffer(2048, 0x52));
  expect(result.fileName).toBe(saved.id);
});
it("blocks nested managed inbound media URI attachments", async () => {
  const cache = createCache([{ index: 0, path: "media://inbound/nested%2Ffile.pdf" }]);
  await expect(cache.getBuffer(request)).rejects.toThrow(/outside allowed roots/i);
});
it.for([true, false])(
  "resolves cwd/state collisions with cwd allowed: %s",
  async (allowedCwd, { base }) => {
    const stateDir = path.join(base, "state");
    const cwd = path.join(base, "cwd");
    const relativePath = "media/inbound/photo.jpg";
    await mediaFile(cwd, relativePath, "cwd-media");
    await mediaFile(stateDir, relativePath, "state-media");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const roots = (allowedCwd ? [cwd, stateDir] : [stateDir]).map((root) =>
        path.join(root, "media"),
      );
      const cache = createCache([{ index: 0, path: relativePath }], { localPathRoots: roots });
      expect((await cache.getBuffer(request)).buffer.toString()).toBe(
        allowedCwd ? "cwd-media" : "state-media",
      );
    });
  },
);
it.for([
  ["directory", /not a regular file/i],
  ["symlink", /outside allowed roots/i],
] as const)("blocks %s attachments inside configured roots", async ([kind, error], { base }) => {
  if (kind === "symlink" && process.platform === "win32") {
    return;
  }
  const file = path.join(base, "entry");
  if (kind === "directory") {
    await fs.mkdir(file);
  } else {
    await fs.symlink("/etc/passwd", file);
  }
  await expect(localCache(file, base).getBuffer(request)).rejects.toThrow(error);
});
it("opens local attachments with nofollow on posix", async ({ base }) => {
  if (process.platform === "win32") {
    return;
  }
  const file = await mediaFile(base, "voice-note.m4a", "ok");
  const openSpy = vi.spyOn(fs, "open");
  await localCache(file, base).getBuffer(request);
  expect(openSpy).toHaveBeenCalled();
  const [openedPath, openedFlags] = mockCall(openSpy);
  expect(await fs.realpath(String(openedPath)).catch(() => String(openedPath))).toBe(
    await fs.realpath(file),
  );
  expect(Number(openedFlags) & ~fsConstants.O_NONBLOCK).toBe(
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
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
      await expect(result).rejects.toMatchObject({
        reason: "blocked",
        message: expect.stringMatching(/could not be canonicalized/i),
      });
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
  const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  const { error, spy } = failPartialWrite();
  const cleanupError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(cleanupError);

  await expect(cache.getPath(request)).rejects.toBe(error);
  expect(await fs.readdir(base)).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining(`could not remove staged attachment ${base}${path.sep}`),
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("remove it manually if it remains: Error: permission denied"),
  );

  const staged = await cache.getPath(request);
  await expectStaged(cache, staged);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(base)).toHaveLength(2);

  unlink.mockRejectedValueOnce(cleanupError);
  await cache.cleanup();
  expect(await fs.readdir(base)).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(2);

  await cache.cleanup();
  expect(await fs.readdir(base)).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(2);
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
