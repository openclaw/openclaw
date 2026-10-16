import { constants } from "node:fs";
// Covers streamed marketplace archive downloads through the installer boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  createMarketplaceInstallInput,
  expectMarketplaceInstallSuccess,
  writeMarketplaceManifest,
} from "./marketplace.test-support.js";

const installPluginFromPathMock = vi.fn();
const installPluginInput = createMarketplaceInstallInput(installPluginFromPathMock);
const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit }) => {
    // Keep unit tests focused on guarded call sites, not AbortSignal timer behavior.
    const { signal: _signal, ...init } = params.init ?? {};
    const response = await fetch(params.url, init);
    return {
      response,
      finalUrl: params.url,
      release: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  }),
);

vi.mock("./install.js", () => ({
  installPluginFromPath: (...args: unknown[]) => installPluginFromPathMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: { url: string; init?: RequestInit }) =>
      fetchWithSsrFGuardMock(params),
  };
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

function fetchGuardInput(callIndex = 0): Record<string, unknown> {
  const input = fetchWithSsrFGuardMock.mock.calls[callIndex]?.[0];
  if (!input || typeof input !== "object") {
    throw new Error(`expected fetch guard input ${callIndex}`);
  }
  return input as Record<string, unknown>;
}

function expectFetchDownloadCall(url = "https://example.com/frontend-design.tgz") {
  const input = fetchGuardInput();
  expect(input.url).toBe(url);
  expect(input.timeoutMs).toBe(120_000);
  expect(input.auditContext).toBe("marketplace-plugin-download");
}

const archiveUrl = "https://example.com/frontend-design.tgz";

async function withArchiveMarketplace(
  run: (
    install: (timeoutMs?: number) => ReturnType<typeof installPluginFromMarketplace>,
    manifestPath: string,
  ) => Promise<void>,
  source = archiveUrl,
) {
  await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
    const manifestPath = await writeMarketplaceManifest(rootDir, {
      plugins: [{ name: "frontend-design", source }],
    });
    await run(
      (timeoutMs) =>
        installPluginFromMarketplace({
          marketplace: manifestPath,
          plugin: "frontend-design",
          timeoutMs,
        }),
      manifestPath,
    );
  });
}

describe("marketplace archive downloads", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["empty", "empty response body"],
    ["HTTP", "HTTP 503"],
    ["non-streaming", "streaming response body unavailable"],
    ["malformed length", "invalid content-length header: 1e9"],
    ["oversized length", "download too large: 268435457 bytes (limit: 268435456 bytes)"],
    ["drive-relative filename", "invalid download filename"],
  ] as const)("rejects %s responses before installing an archive", async (kind, error) => {
    await withArchiveMarketplace(async (install) => {
      const release = vi.fn(async () => undefined);
      const cancel = vi.fn(async () => undefined);
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const reader = { read: vi.fn(), cancel: vi.fn(async () => undefined), releaseLock: vi.fn() };
      const headers = new Headers();
      if (kind === "malformed length" || kind === "oversized length") {
        headers.set("content-length", kind === "malformed length" ? "1e9" : "268435457");
      }
      const response =
        kind === "empty"
          ? new Response(null, { status: 200 })
          : kind === "HTTP"
            ? new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("ignored"));
                  },
                  cancel,
                }),
                { status: 503, statusText: "Service Unavailable" },
              )
            : kind === "drive-relative filename"
              ? new Response(new Blob([Buffer.from("tgz-bytes")]), { status: 200 })
              : ({
                  ok: true,
                  status: 200,
                  headers,
                  arrayBuffer,
                  body: kind === "non-streaming" ? { cancel } : { getReader: () => reader, cancel },
                } as unknown as Response);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response,
        finalUrl:
          kind === "drive-relative filename" ? "https://cdn.example.com/C:plugin.tgz" : archiveUrl,
        release,
      });
      expect(await install()).toEqual({
        ok: false,
        error: `failed to download ${archiveUrl}: ${error}`,
      });
      expectFetchDownloadCall();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      if (kind === "HTTP" || kind === "non-streaming" || kind.endsWith("length")) {
        expect(cancel).toHaveBeenCalledTimes(1);
      }
      if (kind === "non-streaming") {
        expect(arrayBuffer).not.toHaveBeenCalled();
      }
      if (kind.endsWith("length")) {
        expect(reader.read).not.toHaveBeenCalled();
        expect(reader.cancel).not.toHaveBeenCalled();
      }
    });
  });

  it("downloads guarded archives with the default timeout for NaN and tolerates release errors", async () => {
    await withArchiveMarketplace(async (install, manifestPath) => {
      const release = vi.fn(async () => {
        throw new Error("dispatcher close failed");
      });
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), { status: 200 }),
        finalUrl: "https://cdn.example.com/releases/12345",
        release,
      });
      installPluginFromPathMock.mockImplementation(
        async ({ path: archivePath }: { path: string }) => {
          expect(await fs.readFile(archivePath, "utf8")).toBe("tgz-bytes");
          if (process.platform !== "win32") {
            expect((await fs.stat(archivePath)).mode & 0o777).toBe(0o666 & ~process.umask());
          }
          return {
            ok: true,
            pluginId: "frontend-design",
            targetDir: "/tmp/frontend-design",
            version: "0.1.0",
            extensions: ["index.ts"],
          };
        },
      );
      expectMarketplaceInstallSuccess(await install(Number.NaN), {
        pluginId: "frontend-design",
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
  });

  it.each([
    ["oversized", "file exceeds limit of 268435456 bytes (got at least 268435457)"],
    ["interrupted", "archive stream failed"],
  ] as const)("cancels and cleans up an %s archive stream", async (kind, error) => {
    await withArchiveMarketplace(async (install) => {
      const beforeTempDirs = await listMarketplaceDownloadTempDirs();
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const reader = {
        read: vi.fn().mockResolvedValueOnce({
          done: false,
          value:
            kind === "oversized"
              ? new Uint8Array(256 * 1024 * 1024 + 1)
              : Buffer.from("partial archive"),
        }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      };
      if (kind === "oversized") {
        reader.read.mockResolvedValueOnce({ done: true, value: undefined });
      } else {
        reader.read.mockRejectedValueOnce(new Error(error));
      }
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: { getReader: () => reader, cancel: vi.fn(async () => undefined) },
          headers: new Headers(),
          arrayBuffer,
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      expect(await install()).toEqual({
        ok: false,
        error: `failed to download ${archiveUrl}: ${error}`,
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(reader.cancel).toHaveBeenCalledTimes(1);
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
      if (kind === "interrupted") {
        expect(reader.read).toHaveBeenCalledTimes(2);
      }
      expect(await listMarketplaceDownloadTempDirs()).toEqual(beforeTempDirs);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });
  it.each(["open fails", "write makes no progress"])(
    "cancels and removes a download when its file %s",
    async (failure) => {
      const nativeMode = getFsSafeNativeConfig().mode;
      configureFsSafeNative({ mode: "off" });
      await withArchiveMarketplace(async (install) => {
        const cancel = vi.fn();
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from("archive fixture"));
            },
            cancel,
          }),
        );
        const release = vi.fn(async () => undefined);
        fetchWithSsrFGuardMock.mockResolvedValueOnce({
          response,
          finalUrl: "https://example.com/frontend-design.tgz",
          release,
        });
        const open = fs.open.bind(fs);
        const attemptedPaths: string[] = [];
        const downloads: { pathname: string; handle: Awaited<ReturnType<typeof fs.open>> }[] = [];
        vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
          const isDownload =
            String(pathname).includes("openclaw-marketplace-download-") &&
            (flags === "wx" || (typeof flags === "number" && (flags & constants.O_WRONLY) !== 0));
          if (isDownload) {
            attemptedPaths.push(String(pathname));
            if (failure === "open fails") {
              throw Object.assign(new Error("download destination unavailable"), {
                code: "EACCES",
              });
            }
          }
          const handle = await open(pathname, flags, mode);
          if (isDownload) {
            downloads.push({ pathname: String(pathname), handle });
            vi.spyOn(handle, "write").mockImplementation(async (buffer) => ({
              bytesWritten: 0,
              buffer,
            }));
          }
          return handle;
        });

        const result = await install();

        expect(result).toEqual({
          ok: false,
          error: expect.stringContaining(
            failure === "open fails"
              ? "download destination unavailable"
              : "file write made no progress",
          ),
        });
        expect(attemptedPaths).toHaveLength(1);
        for (const download of downloads) {
          await expect(download.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
        }
        await expect(fs.stat(path.dirname(attemptedPaths[0]!))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.body?.locked).toBe(false);
        expect(release).toHaveBeenCalledTimes(1);
        expect(installPluginFromPathMock).not.toHaveBeenCalled();
      }).finally(() => configureFsSafeNative({ mode: nativeMode }));
    },
  );

  it.each(["invalid URL", "guard rejection"] as const)("sanitizes %s errors", async (failure) => {
    const invalid = failure === "invalid URL";
    if (!invalid) {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error(
          "blocked\n\u001b[31mAuthorization: Bearer sk-1234567890abcdefghijklmnop\u001b[0m",
        ),
      );
    }
    await withArchiveMarketplace(
      async (install) => {
        const result = await install();
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
          expect(
            Array.from(result.error).some((char) => {
              const codePoint = char.codePointAt(0);
              return codePoint != null && (codePoint < 0x20 || codePoint === 0x7f);
            }),
          ).toBe(false);
        }
        expect(installPluginFromPathMock).not.toHaveBeenCalled();
      },
      invalid
        ? "https://%/frontend-design.tgz"
        : "https://user:pass@example.com/frontend-design.tgz",
    );
  });
});
