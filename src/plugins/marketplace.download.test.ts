// Covers streamed marketplace archive downloads through the installer boundary.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
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
let installPluginFromMarketplace: typeof import("./marketplace.js").installPluginFromMarketplace;

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

beforeAll(async () => {
  ({ installPluginFromMarketplace } = await import("./marketplace.js"));
});

async function listMarketplaceDownloadTempDirs(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("openclaw-marketplace-download-"),
    )
    .map((entry) => entry.name)
    .toSorted();
}

function writeArchiveMarketplaceManifest(rootDir: string): Promise<string> {
  return writeMarketplaceManifest(rootDir, {
    plugins: [
      {
        name: "frontend-design",
        source: "https://example.com/frontend-design.tgz",
      },
    ],
  });
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

function cancelTrackedResponse(init?: ResponseInit): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("ignored"));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("marketplace archive downloads", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    installPluginFromPathMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a structured error for archive downloads with an empty response body", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://example.com/frontend-design.tgz",
        release,
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download https://example.com/frontend-design.tgz: empty response body",
      });
      expectFetchDownloadCall();
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels archive download error bodies before returning structured HTTP errors", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const tracked = cancelTrackedResponse({
        status: 503,
        statusText: "Service Unavailable",
      });
      const release = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: tracked.response,
        finalUrl: "https://example.com/frontend-design.tgz",
        release,
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download https://example.com/frontend-design.tgz: HTTP 503",
      });
      expect(tracked.wasCanceled()).toBe(true);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("redacts invalid archive URLs in structured errors", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://%/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error: "failed to download ***: Invalid URL",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    });
  });

  it("rejects Windows drive-relative archive filenames from redirects", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/C:plugin.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: invalid download filename",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("falls back to the default archive timeout when the caller passes NaN", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/releases/12345",
        release: vi.fn(async () => undefined),
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
        timeoutMs: Number.NaN,
      });

      expectMarketplaceInstallSuccess(result, {
        pluginId: "frontend-design",
      });
      expectFetchDownloadCall();
    });
  });

  it("downloads archive plugin sources through the SSRF guard", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const release = vi.fn(async () => {
        throw new Error("dispatcher close failed");
      });
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: new Response(new Blob([Buffer.from("tgz-bytes")]), {
          status: 200,
        }),
        finalUrl: "https://cdn.example.com/releases/12345",
        release,
      });
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "frontend-design",
        targetDir: "/tmp/frontend-design",
        version: "0.1.0",
        extensions: ["index.ts"],
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expectMarketplaceInstallSuccess(result, {
        marketplacePlugin: "frontend-design",
        marketplaceSource: manifestPath,
      });
      expectFetchDownloadCall();
      expect(String(installPluginInput().path)).toMatch(/[\\/]frontend-design\.tgz$/);
      expect(installPluginInput().installPolicyRequest).toMatchObject({
        kind: "plugin-archive",
        requestedSpecifier: `frontend-design@${manifestPath}`,
        source: {
          kind: "archive",
          authority: "third-party",
          mutable: true,
          network: true,
        },
      });
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects non-streaming archive responses before buffering them", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const cancel = vi.fn(async () => undefined);
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: { cancel } as unknown as Response["body"],
          headers: new Headers(),
          arrayBuffer,
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "streaming response body unavailable",
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("rejects oversized streamed archive responses without falling back to arrayBuffer", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: {
              length: 256 * 1024 * 1024 + 1,
            } as Uint8Array,
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      };
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {
            getReader: () => reader,
          } as unknown as Response["body"],
          headers: new Headers(),
          arrayBuffer,
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "download too large: 268435457 bytes (limit: 268435456 bytes)",
      });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(reader.cancel).toHaveBeenCalledTimes(1);
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed archive content-length headers before streaming", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const cancel = vi.fn(async () => undefined);
      const reader = {
        read: vi.fn(),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      };
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {
            getReader: () => reader,
            cancel,
          } as unknown as Response["body"],
          headers: new Headers({ "content-length": "1e9" }),
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "invalid content-length header: 1e9",
      });
      expect(reader.read).not.toHaveBeenCalled();
      expect(reader.cancel).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("rejects oversized archive content-length headers before streaming", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const cancel = vi.fn(async () => undefined);
      const reader = {
        read: vi.fn(),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      };
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {
            getReader: () => reader,
            cancel,
          } as unknown as Response["body"],
          headers: new Headers({ "content-length": String(256 * 1024 * 1024 + 1) }),
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "download too large: 268435457 bytes (limit: 268435456 bytes)",
      });
      expect(reader.read).not.toHaveBeenCalled();
      expect(reader.cancel).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("cleans up a partial download temp dir when streaming the archive fails", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const beforeTempDirs = await listMarketplaceDownloadTempDirs();
      const reader = {
        read: vi.fn(async () => ({
          done: false,
          value: { length: 268_435_457 },
        })),
        releaseLock: vi.fn(),
      };
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: {
          ok: true,
          status: 200,
          body: {
            getReader: () => reader,
          } as unknown as Response["body"],
          headers: new Headers(),
        } as unknown as Response,
        finalUrl: "https://cdn.example.com/releases/frontend-design.tgz",
        release: vi.fn(async () => undefined),
      });
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "download too large: 268435457 bytes (limit: 268435456 bytes)",
      });
      expect(reader.read).toHaveBeenCalledTimes(1);
      expect(reader.releaseLock).toHaveBeenCalledTimes(1);
      expect(await listMarketplaceDownloadTempDirs()).toEqual(beforeTempDirs);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("cancels and removes a download when its file write makes no progress", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);
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
      const downloads: { pathname: string; handle: Awaited<ReturnType<typeof fs.open>> }[] = [];
      vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
        const handle = await open(pathname, flags, mode);
        if (flags === "wx" && path.basename(String(pathname)) === "frontend-design.tgz") {
          downloads.push({ pathname: String(pathname), handle });
          vi.spyOn(handle, "write").mockImplementation(async (buffer) => ({
            bytesWritten: 0,
            buffer,
          }));
        }
        return handle;
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: file write made no progress",
      });
      expect(downloads).toHaveLength(1);
      await expect(downloads[0]!.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
      await expect(fs.stat(path.dirname(downloads[0]!.pathname))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body?.locked).toBe(false);
      expect(release).toHaveBeenCalledTimes(1);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("sanitizes archive download errors before returning them", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error(
          "blocked\n\u001b[31mAuthorization: Bearer sk-1234567890abcdefghijklmnop\u001b[0m",
        ),
      );
      const manifestPath = await writeMarketplaceManifest(rootDir, {
        plugins: [
          {
            name: "frontend-design",
            source: "https://user:pass@example.com/frontend-design.tgz",
          },
        ],
      });

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

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
      let hasControlChars = false;
      for (const char of result.error) {
        const codePoint = char.codePointAt(0);
        if (codePoint != null && (codePoint < 0x20 || codePoint === 0x7f)) {
          hasControlChars = true;
          break;
        }
      }
      expect(hasControlChars).toBe(false);
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });

  it("returns a structured error when the SSRF guard rejects an archive URL", async () => {
    await withTempDir("openclaw-marketplace-test-", async (rootDir) => {
      fetchWithSsrFGuardMock.mockRejectedValueOnce(
        new Error("Blocked hostname (not in allowlist): 169.254.169.254"),
      );
      const manifestPath = await writeArchiveMarketplaceManifest(rootDir);

      const result = await installPluginFromMarketplace({
        marketplace: manifestPath,
        plugin: "frontend-design",
      });

      expect(result).toEqual({
        ok: false,
        error:
          "failed to download https://example.com/frontend-design.tgz: " +
          "Blocked hostname (not in allowlist): 169.254.169.254",
      });
      expect(installPluginFromPathMock).not.toHaveBeenCalled();
    });
  });
});
