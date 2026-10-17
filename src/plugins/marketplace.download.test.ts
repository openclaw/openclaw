import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  createMarketplaceInstallInput,
  expectMarketplaceInstallSuccess,
  writeMarketplaceManifest,
} from "./marketplace.test-support.js";

const installPluginFromPathMock = vi.fn();
const installPluginInput = createMarketplaceInstallInput(installPluginFromPathMock);
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>(),
);

vi.mock("./install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return { ...actual, fetchWithSsrFGuard: fetchWithSsrFGuardMock };
});

async function listMarketplaceDownloadTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(resolvePreferredOpenClawTmpDir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("openclaw-marketplace-download-"),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function expectFetchDownloadCall(url = "https://example.com/frontend-design.tgz") {
  expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
    url,
    timeoutMs: 120_000,
    auditContext: "marketplace-plugin-download",
  });
}

const archiveUrl = "https://example.com/frontend-design.tgz";
let rootDir: string;
let manifestPath: string;
let nativeMode: ReturnType<typeof getFsSafeNativeConfig>["mode"];
function respond(
  response: Response,
  finalUrl = archiveUrl,
  release: () => Promise<void> = vi.fn(async () => undefined),
) {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, finalUrl, release });
  return release;
}

function streamingResponse(cancel: () => void | Promise<void>, status = 200) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(Buffer.from("archive fixture")),
      cancel,
    }),
    { status },
  );
}

function fakeResponse(kind = "stream") {
  const cancel = vi.fn(async () => undefined);
  const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
  const reader = { read: vi.fn(), cancel: vi.fn(async () => undefined), releaseLock: vi.fn() };
  const response = {
    ok: true,
    status: 200,
    arrayBuffer,
    headers: new Headers(
      kind.endsWith("length")
        ? { "content-length": kind === "malformed length" ? "1e9" : "268435457" }
        : {},
    ),
    body: { getReader: () => reader, cancel },
  } as unknown as Response;
  return { response, reader, cancel, arrayBuffer };
}

function expectDownloadFailure(result: unknown, error: string) {
  expect(result).toEqual({ ok: false, error: `failed to download ${archiveUrl}: ${error}` });
  expect(installPluginFromPathMock).not.toHaveBeenCalled();
}

async function install(timeoutMs?: number, source = archiveUrl) {
  manifestPath = await writeMarketplaceManifest(rootDir, {
    plugins: [{ name: "frontend-design", source }],
  });
  return installPluginFromMarketplace({
    marketplace: manifestPath,
    plugin: "frontend-design",
    timeoutMs,
  });
}

beforeEach(async () => {
  nativeMode = getFsSafeNativeConfig().mode;
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-test-"));
});
afterEach(async () => {
  fetchWithSsrFGuardMock.mockClear();
  installPluginFromPathMock.mockReset();
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: nativeMode });
  await fs.rm(rootDir, { recursive: true, force: true });
});

it.each([
  ["empty", "empty response body"],
  ["HTTP", "HTTP 503"],
  ["malformed length", "invalid content-length header: 1e9"],
  ["oversized length", "download too large: 268435457 bytes (limit: 268435456 bytes)"],
  ["drive-relative filename", "invalid download filename"],
] as const)("rejects %s responses before installing an archive", async (kind, error) => {
  const fixture = fakeResponse(kind);
  const response =
    kind === "HTTP"
      ? streamingResponse(fixture.cancel, 503)
      : kind === "empty"
        ? new Response(null)
        : kind === "drive-relative filename"
          ? new Response("tgz-bytes")
          : fixture.response;
  const release = respond(
    response,
    kind === "drive-relative filename" ? "https://cdn.example.com/C:plugin.tgz" : archiveUrl,
  );
  expectDownloadFailure(await install(), error);
  expectFetchDownloadCall();
  expect(release).toHaveBeenCalledTimes(1);
  if (kind === "HTTP" || kind.endsWith("length")) {
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  }
  if (kind.endsWith("length")) {
    expect(fixture.reader.read).not.toHaveBeenCalled();
    expect(fixture.reader.cancel).not.toHaveBeenCalled();
  }
});

it("downloads archives with NaN timeout and failing release", async () => {
  const release = vi.fn(async () => {
    throw new Error("dispatcher close failed");
  });
  respond(new Response("tgz-bytes"), "https://cdn.example.com/releases/12345", release);
  installPluginFromPathMock.mockImplementation(async ({ path: archivePath }: { path: string }) => {
    expect(await fs.readFile(archivePath, "utf8")).toBe("tgz-bytes");
    if (process.platform !== "win32") {
      expect((await fs.stat(archivePath)).mode & 0o777).toBe(0o666 & ~process.umask());
    }
    return { ok: true, pluginId: "frontend-design" };
  });
  expectMarketplaceInstallSuccess(await install(Number.NaN), {
    marketplacePlugin: "frontend-design",
    marketplaceSource: manifestPath,
  });
  expectFetchDownloadCall();
  expect(String(installPluginInput().path)).toMatch(/[\\/]frontend-design\.tgz$/);
  expect(installPluginInput().installPolicyRequest).toMatchObject({
    kind: "plugin-archive",
    requestedSpecifier: `frontend-design@${manifestPath}`,
    source: { kind: "archive", authority: "third-party", mutable: true, network: true },
  });
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([
  ["oversized", "file exceeds limit of 268435456 bytes (got at least 268435457)"],
  ["interrupted", "archive stream failed"],
] as const)("cancels and cleans up an %s archive stream", async (kind, error) => {
  const beforeTempDirs = await listMarketplaceDownloadTempDirs();
  const { response, reader, arrayBuffer } = fakeResponse();
  reader.read.mockResolvedValueOnce({
    done: false,
    value:
      kind === "oversized" ? new Uint8Array(256 * 1024 * 1024 + 1) : Buffer.from("partial archive"),
  });
  if (kind === "interrupted") {
    reader.read.mockRejectedValueOnce(new Error(error));
  }
  respond(response, "https://cdn.example.com/releases/frontend-design.tgz");
  expectDownloadFailure(await install(), error);
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  if (kind === "interrupted") {
    expect(reader.read).toHaveBeenCalledTimes(2);
  }
  expect(await listMarketplaceDownloadTempDirs()).toEqual(beforeTempDirs);
});
it.each(["open fails", "write makes no progress"])("cleans up after %s", async (failure) => {
  configureFsSafeNative({ mode: "off" });
  const cancel = vi.fn();
  const response = streamingResponse(cancel);
  const release = respond(response);
  const open = fs.open.bind(fs);
  const attemptedPaths: string[] = [];
  const downloads: Awaited<ReturnType<typeof fs.open>>[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
    const isDownload =
      String(pathname).includes("openclaw-marketplace-download-") &&
      (flags === "wx" || (typeof flags === "number" && (flags & constants.O_WRONLY) !== 0));
    if (!isDownload) {
      return open(pathname, flags, mode);
    }
    attemptedPaths.push(String(pathname));
    if (failure === "open fails") {
      throw Object.assign(new Error("download destination unavailable"), { code: "EACCES" });
    }
    const handle = await open(pathname, flags, mode);
    downloads.push(handle);
    vi.spyOn(handle, "write").mockImplementation(async (buffer) => ({ bytesWritten: 0, buffer }));
    return handle;
  });

  expect(await install()).toEqual({
    ok: false,
    error: expect.stringContaining(
      failure === "open fails" ? "download destination unavailable" : "file write made no progress",
    ),
  });
  expect(attemptedPaths).toHaveLength(1);
  for (const handle of downloads) {
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  }
  await expect(fs.stat(path.dirname(attemptedPaths[0]!))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
  expect(installPluginFromPathMock).not.toHaveBeenCalled();
});

it.each(["invalid URL", "guard rejection"] as const)("sanitizes %s errors", async (failure) => {
  const invalid = failure === "invalid URL";
  if (!invalid) {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(
      new Error("blocked\n\u001b[31mAuthorization: Bearer sk-1234567890abcdefghijklmnop\u001b[0m"),
    );
  }
  const result = await install(
    undefined,
    invalid ? "https://%/frontend-design.tgz" : "https://user:pass@example.com/frontend-design.tgz",
  );
  if (invalid) {
    expect(result).toEqual({ ok: false, error: "failed to download ***: Invalid URL" });
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  } else {
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain(
      "failed to download https://***:***@example.com/frontend-design.tgz:",
    );
    expect(result.error).toContain("Authorization: Bearer sk-123…");
    expect(result.error).not.toContain("abcdefghijklmnop");
    expect(result.error).not.toContain("user:pass@");
    expect(Array.from(result.error).some((char) => char < " " || char === "\u007f")).toBe(false);
  }
  expect(installPluginFromPathMock).not.toHaveBeenCalled();
});
