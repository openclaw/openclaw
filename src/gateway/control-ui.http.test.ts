import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configIo from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  createGatewayAuthRateLimiter,
} from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "./control-ui-contract.js";
import {
  createTrustedProxyHeaders,
  setupTrustedProxyAuth,
} from "./control-ui.http.test-support.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { createAuthRateLimiterSpy, makeMockHttpResponse } from "./test-http-response.js";

type PlaybackTranscodeResolution = Awaited<
  ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"]>
>;
type FileHandleRead = (
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

const resolvePlaybackTranscodeMock = vi.hoisted(() =>
  vi.fn(async (): Promise<PlaybackTranscodeResolution> => ({ kind: "passthrough" })),
);
// Keep bootstrap independent of this checkout's branch.
vi.mock("../infra/dev-install-branch.js", () => ({
  resolveDevInstallGitBranch: async () => null,
}));
vi.mock("../media/playback-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/playback-transcode.js")>();
  return {
    ...actual,
    resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
  };
});

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenAuth = { mode: "token", token: "test-token", allowTailscale: false } as const;

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  resolvePlaybackTranscodeMock.mockReset();
  resolvePlaybackTranscodeMock.mockResolvedValue({ kind: "passthrough" });
});

describe("handleControlUiHttpRequest", () => {
  function createAvatarConfig(workspace: string, avatar: string): OpenClawConfig {
    return { agents: { list: [{ id: "main", workspace, identity: { avatar } }] } };
  }

  async function createControlUiRoot(indexHtml = "<html></html>\n") {
    const tmp = testTempDirs.make("openclaw-ui-");
    await fs.writeFile(path.join(tmp, "index.html"), indexHtml);
    return tmp;
  }

  function responseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return String(end.mock.calls[0]?.[0] ?? "");
  }

  function responseJson(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(responseBody(end)) as unknown;
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(responseBody(end)) as ControlUiBootstrapConfig;
  }

  function expectNotFoundResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(404);
    expect(params.end).toHaveBeenCalledWith("Not Found");
  }

  type RequestParams = {
    url: string;
    method?: "GET" | "HEAD" | "POST";
    headers?: IncomingMessage["headers"];
    distinctHeaders?: IncomingMessage["headersDistinct"];
    remoteAddress?: string;
  };
  type AuthParams = {
    auth?: ResolvedGatewayAuth;
    trustedProxies?: string[];
    basePath?: string;
  };

  function makeRequest(params: RequestParams): IncomingMessage {
    const headers = params.headers ?? {};
    return {
      url: params.url,
      method: params.method ?? "GET",
      headers,
      headersDistinct:
        params.distinctHeaders ??
        Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value : [String(value)],
          ]),
        ),
      socket: { remoteAddress: params.remoteAddress ?? "127.0.0.1" },
    } as IncomingMessage;
  }

  async function runRequest<Options>(
    handler: (req: IncomingMessage, res: ServerResponse, options: Options) => Promise<boolean>,
    params: RequestParams,
    options: Options,
  ) {
    const response = makeMockHttpResponse();
    const handled = await handler(makeRequest(params), response.res, options);
    return { ...response, handled };
  }

  type ControlRequestParams = RequestParams &
    Omit<NonNullable<Parameters<typeof handleControlUiHttpRequest>[2]>, "root"> & {
      rootPath: string;
      rootKind?: "resolved" | "bundled";
      retainedAssets?: ControlUiAssetRetention;
    };

  function runControlUiRequest(
    rootPath: string,
    url: string,
    {
      rootKind = "resolved",
      retainedAssets,
      ...params
    }: Omit<ControlRequestParams, "url" | "rootPath"> = {},
  ) {
    return runRequest(
      handleControlUiHttpRequest,
      { ...params, url },
      {
        ...params,
        root:
          rootKind === "bundled"
            ? { kind: rootKind, path: rootPath, retainedAssets }
            : { kind: rootKind, path: rootPath },
      },
    );
  }

  function runBootstrapConfigRequest({ rootPath, ...params }: Omit<ControlRequestParams, "url">) {
    return runControlUiRequest(
      rootPath,
      `${params.basePath ?? ""}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      params,
    );
  }

  function runAvatarRequest(params: RequestParams & AuthParams & { config: OpenClawConfig }) {
    return runRequest(handleControlUiAvatarRequest, params, params);
  }

  function runAssistantMediaRequest(params: RequestParams & AuthParams) {
    return runRequest(handleControlUiAssistantMediaRequest, params, {
      ...params,
      auth: params.auth ?? tokenAuth,
    });
  }

  async function runTrustedProxyAssistantMediaRequest(params: {
    filePath: string;
    headers?: IncomingMessage["headers"];
  }) {
    return await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(params.filePath)}`,
      auth: setupTrustedProxyAuth(),
      trustedProxies: ["10.0.0.1"],
      remoteAddress: "10.0.0.1",
      headers: createTrustedProxyHeaders(params.headers),
    });
  }

  function expectMissingOperatorReadResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(403);
    expect(responseJson(params.end)).toEqual({
      ok: false,
      error: {
        type: "forbidden",
        message: "missing scope: operator.read",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      },
    });
  }

  function expectRateLimited(result: Awaited<ReturnType<typeof runBootstrapConfigRequest>>) {
    expect(result.handled).toBe(true);
    expect(result.res.statusCode).toBe(429);
    expect(responseJson(result.end)).toEqual({
      error: {
        message: "Too many failed authentication attempts. Please try again later.",
        type: "rate_limited",
      },
    });
    expect(result.setHeader).toHaveBeenCalledWith("Retry-After", "3");
  }

  async function writeAssetFile(rootPath: string, filename: string, contents: string) {
    const assetsDir = path.join(rootPath, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, contents);
    return { assetsDir, filePath };
  }

  async function createMediaFile(
    filename = "photo.png",
    bytes: string | Buffer = "not-a-real-png",
  ) {
    const root = testTempDirs.make("ui-media-", resolvePreferredOpenClawTmpDir());
    const filePath = path.join(root, filename);
    await fs.writeFile(filePath, bytes);
    return filePath;
  }

  async function forceFirstFileHandleShortRead(filePath: string, maxBytes: number) {
    const probe = await fs.open(filePath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandleRead };
    const originalRead = fileHandlePrototype.read;
    await probe.close();
    let constrained = false;
    return vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: unknown,
      target,
      offset,
      length,
      position,
    ) {
      if (!constrained && position === 0 && length > maxBytes) {
        constrained = true;
        return await originalRead.call(this, target, offset, maxBytes, position);
      }
      return await originalRead.call(this, target, offset, length, position);
    });
  }

  async function createBasePathRootFixture() {
    const tmp = testTempDirs.make("openclaw-ui-root-");
    const root = path.join(tmp, "ui");
    const sibling = path.join(tmp, "outside");
    await fs.mkdir(root);
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(root, "index.html"), "<html>ok</html>\n");
    return { root, sibling };
  }

  async function withControlUiHome<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    let databasePath: string | undefined;
    try {
      return await withEnvAsync({ OPENCLAW_HOME: tempHome }, async () => {
        databasePath = resolveOpenClawStateSqlitePath();
        return await fn();
      });
    } finally {
      // A failed database close must leave its files intact.
      if (databasePath) {
        await closeOpenClawStateDatabaseByPathAsync(databasePath);
      }
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }

  async function withPairedOperatorDeviceToken<T>(
    fn: (token: string) => Promise<T>,
    issuerGeneration?: string,
  ) {
    return await withControlUiHome("openclaw-ui-device-token-", async () => {
      const deviceId = "control-ui-device";
      const requested = await requestDevicePairing({
        deviceId,
        publicKey: "test-public-key",
        role: "operator",
        scopes: ["operator.read"],
        ...(issuerGeneration
          ? {
              clientId: "openclaw-control-ui",
              clientMode: "webchat",
            }
          : {}),
      });
      const approved = await approveDevicePairing(requested.request.requestId, {
        callerScopes: ["operator.read"],
      });
      expect(approved?.status).toBe("approved");
      let operatorToken =
        approved?.status === "approved" ? approved.device.tokens?.operator?.token : undefined;
      if (issuerGeneration) {
        const issued = await ensureDeviceToken({
          deviceId,
          role: "operator",
          scopes: ["operator.read"],
          issuer: {
            kind: "shared-gateway-auth",
            generation: issuerGeneration,
          },
        });
        operatorToken = issued?.token;
      }
      expect(typeof operatorToken).toBe("string");
      return await fn(operatorToken ?? "");
    });
  }

  it("sets security headers for Control UI responses", async () => {
    const script = "console.log('inline');";
    const tmp = await createControlUiRoot(`<html><script>${script}</script></html>`);

    const { end, setHeader, handled } = await runControlUiRequest(tmp, "/", {
      headers: { host: "gateway.example.test" },
    });
    expect(handled).toBe(true);
    expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
    const csp = setHeader.mock.calls.findLast((call) => call[0] === "Content-Security-Policy")?.[1];
    expect(typeof csp).toBe("string");
    expect(String(csp)).toContain("frame-ancestors 'none'");
    expect(String(csp)).toContain("frame-src 'self'");
    expect(
      String(csp)
        .split("; ")
        .find((directive) => directive.startsWith("script-src ")),
    ).toBe(
      `script-src 'self' 'sha256-${createHash("sha256").update(script).digest("base64")}' 'wasm-unsafe-eval'`,
    );
    expect(String(csp)).toContain(
      "connect-src 'self' ws: wss: data: blob: https://api.openai.com https://tweakcn.com",
    );
    expect(String(csp)).not.toContain("https://*.tweakcn.com");
    expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
    );
    expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="true"');
  });

  it("uses effective terminal availability instead of raw restart-pending config", async () => {
    const tmp = await createControlUiRoot();
    const { end, setHeader } = await runControlUiRequest(tmp, "/", {
      headers: { host: "gateway.example.test" },
      config: { gateway: { terminal: { enabled: true } } },
      terminalEnabled: false,
    });
    const csp = setHeader.mock.calls.findLast((call) => call[0] === "Content-Security-Policy")?.[1];
    expect(String(csp)).not.toContain("'wasm-unsafe-eval'");
    expect(responseBody(end)).toContain('data-openclaw-terminal-enabled="false"');

    const bootstrap = await runControlUiRequest(tmp, CONTROL_UI_BOOTSTRAP_CONFIG_PATH, {
      config: { gateway: { terminal: { enabled: false } } },
      terminalEnabled: true,
    });
    expect(parseBootstrapPayload(bootstrap.end).terminalEnabled).toBe(true);
  });

  it("serves fresh media after an in-place rewrite preserves size and mtime", async () => {
    const original = Buffer.from("original media bytes");
    const filePath = await createMediaFile("sample.bin", original);
    const replacement = Buffer.from("replaced media bytes");
    const modified = new Date("2025-01-01T00:00:00.000Z");
    await fs.utimes(filePath, modified, modified);
    const url = `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}`;
    const read = (method: "GET" | "HEAD", conditions: IncomingMessage["headers"] = {}) =>
      runAssistantMediaRequest({
        url,
        method,
        headers: { authorization: "Bearer test-token", ...conditions },
      });
    const initial = await read("HEAD");
    const etag = String(
      initial.setHeader.mock.calls.find(([name]) => name === "ETag")?.[1] ?? '"cached-version"',
    );
    const lastModified = modified.toUTCString();
    await fs.writeFile(filePath, replacement);
    await fs.utimes(filePath, modified, modified);
    const stat = await fs.stat(filePath);
    expect(stat.size).toBe(original.length);
    expect(stat.mtimeMs).toBe(modified.getTime());
    expect(await fs.readFile(filePath)).toEqual(replacement);

    for (const method of ["GET", "HEAD"] as const) {
      for (const condition of [
        { "if-none-match": etag },
        { "if-modified-since": lastModified },
        { range: "bytes=0-3", "if-range": etag },
        { range: "bytes=0-3", "if-range": lastModified },
      ]) {
        const current = await read(method, condition);
        expect.soft(current.res.statusCode, `${method} ${JSON.stringify(condition)}`).toBe(200);
        expect.soft(current.setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
        expect.soft(current.setHeader).not.toHaveBeenCalledWith("Last-Modified", expect.anything());
      }
    }
    const ranged = await read("GET", { range: "bytes=0-3" });
    expect(ranged.res.statusCode).toBe(206);
    expect(ranged.setHeader).toHaveBeenCalledWith(
      "Content-Range",
      `bytes 0-3/${replacement.length}`,
    );
    for (const method of ["GET", "HEAD"] as const) {
      const exists = await read(method, { "if-none-match": "*", range: "bytes=0-3" });
      expect(exists.res.statusCode).toBe(304);
      expect(exists.end).toHaveBeenCalledWith();
      expect(exists.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
    }
  });

  it("returns 202 while assistant playback media is preparing", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "preparing" });
    const filePath = await createMediaFile("voice.caf", Buffer.from("caff-original"));
    const { res, handled, end } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?playback=1&source=${encodeURIComponent(filePath)}&token=test-token`,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(202);
    expect(responseJson(end)).toEqual({ status: "preparing" });
  });

  it("falls back to original assistant media when playback transcode fails", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "fallback" });
    const filePath = await createMediaFile("voice.caf", Buffer.from("caff-original"));
    const { res, handled, setHeader } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?playback=1&source=${encodeURIComponent(filePath)}&token=test-token`,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "audio/x-caf");
    expect(resolvePlaybackTranscodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/x-caf", kind: "audio" }),
    );
  });

  it("serves local video inline and ignores an inbound filename hint", async () => {
    const filePath = await createMediaFile("clip.mp4", "fixture");
    const { res, handled, setHeader } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&filename=ignored.txt&token=test-token`,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      "inline; filename=\"clip.mp4\"; filename*=UTF-8''clip.mp4",
    );
  });

  it("caps and encodes Unicode assistant media filenames without splitting surrogate pairs", async () => {
    const filename = `${"a".repeat(176)}测试 100% 'draft' (1)😀${"b".repeat(20)}.pdf`;
    const filePath = await createMediaFile(filename, "fixture");
    const { res, handled } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res["setHeader"]).toHaveBeenCalledWith(
      "Content-Disposition",
      `attachment; filename="${"a".repeat(176)}__ 100_ 'draft' (1)__.pdf"; filename*=UTF-8''${"a".repeat(176)}%E6%B5%8B%E8%AF%95%20100%25%20%27draft%27%20%281%29%F0%9F%98%80.pdf`,
    );
  });

  it("sanitizes control characters and ill-formed surrogates in assistant media filenames", () => {
    expect(buildAssistantMediaContentDisposition("draft\r\n\uD800.pdf", "application/pdf")).toBe(
      `attachment; filename="draft___.pdf"; filename*=UTF-8''draft__%EF%BF%BD.pdf`,
    );
  });

  it("rejects assistant local media outside allowed preview roots", async () => {
    const tmp = testTempDirs.make("openclaw-ui-media-blocked-");
    const filePath = path.join(tmp, "photo.png");
    await fs.writeFile(filePath, Buffer.from("not-a-real-png"));
    const { res, handled, end } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
    });
    expectNotFoundResponse({ handled, res, end });
  });

  it("fully reads the served assistant media MIME prefix after a short read", async () => {
    const filePath = await createMediaFile("photo.bin", REAL_PNG);
    const readSpy = await forceFirstFileHandleShortRead(filePath, 1);

    const { res, handled, setHeader } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=test-token`,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reports assistant media metadata when the process clock is outside the Date range", async () => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const filePath = await createMediaFile();
    const { res, handled, end } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&token=test-token`,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const payload = responseJson(end);
    expect(payload).toMatchObject({ available: true });
    expect(payload).not.toHaveProperty("mediaTicket");
    expect(payload).not.toHaveProperty("mediaTicketExpiresAt");
  });

  it("serves assistant local media with a scoped media ticket after metadata auth", async () => {
    const filePath = await createMediaFile();
    const meta = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const payload = responseJson(meta.end) as {
      mediaTicket?: string;
    };
    expect(meta.handled).toBe(true);
    expect(meta.res.statusCode).toBe(200);
    expect(payload.mediaTicket).toMatch(/^v1\./);

    const media = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
    });
    expect(media.handled).toBe(true);
    expect(media.res.statusCode).toBe(200);

    const shortenedTicket = payload.mediaTicket?.slice(0, -1) ?? "";
    const rejected = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(shortenedTicket)}`,
      auth: { mode: "token", token: "test-auth-token", allowTailscale: false },
    });
    expect(rejected.handled).toBe(true);
    expect(rejected.res.statusCode).toBe(401);
  });

  it("does not refresh assistant media tickets without operator auth", async () => {
    const filePath = await createMediaFile();
    const meta = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
      headers: {
        authorization: "Bearer test-token",
      },
    });
    const payload = responseJson(meta.end) as {
      mediaTicket?: string;
    };

    const refresh = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
    });
    expect(refresh.handled).toBe(true);
    expect(refresh.res.statusCode).toBe(401);
    expect(responseBody(refresh.end)).toContain("Unauthorized");
  });

  it("reports assistant local media availability failures with a reason", async () => {
    const { res, handled, end } = await runAssistantMediaRequest({
      url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent("/Users/test/Documents/private.pdf")}&token=test-token`,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      available: false,
      code: "outside-allowed-folders",
      reason: "Outside allowed folders",
      retryable: false,
      canAllow: true,
    });
  });

  it("accepts shared-gateway issuer tagged device tokens on assistant media requests", async () => {
    const auth = {
      mode: "token",
      token: "shared-token",
      allowTailscale: false,
    } satisfies ResolvedGatewayAuth;
    const issuerGeneration = resolveSharedGatewaySessionGeneration(auth);
    expect(typeof issuerGeneration).toBe("string");
    await withPairedOperatorDeviceToken(async (operatorToken) => {
      const filePath = await createMediaFile();
      const { res, handled } = await runAssistantMediaRequest({
        url: `/__openclaw__/assistant-media?source=${encodeURIComponent(filePath)}&token=${encodeURIComponent(operatorToken)}`,
        auth,
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    }, issuerGeneration);
  });

  it("rejects trusted-proxy assistant media requests from disallowed browser origins", async () => {
    const filePath = await createMediaFile();
    const { res, handled, end } = await runTrustedProxyAssistantMediaRequest({
      filePath,
      headers: {
        origin: "https://evil.example",
      },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(responseBody(end)).toContain("Unauthorized");
  });

  it("rejects trusted-proxy assistant media file reads without operator.read scope", async () => {
    const filePath = await createMediaFile();
    const { res, handled, end } = await runTrustedProxyAssistantMediaRequest({
      filePath,
      headers: {
        "x-openclaw-scopes": "operator.approvals",
      },
    });
    expectMissingOperatorReadResponse({ handled, res, end });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    const tmp = await createControlUiRoot(html);

    const { end, handled } = await runControlUiRequest(tmp, "/", {
      headers: { host: "gateway.example.test" },
      config: {
        agents: {
          defaults: { workspace: tmp },
          list: [
            { id: "main", identity: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
          ],
        },
      },
    });
    expect(handled).toBe(true);
    expect(end).toHaveBeenCalledWith(
      html.replace(
        "<html",
        '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="true"',
      ),
    );
  });

  it.each(["", "/openclaw/"])(
    "activates only the initial route's modulepreloads under %j",
    async (basePath) => {
      const script = "window.controlUiBoot = true;";
      const html = `<html><head><script>${script}</script><link rel="modulepreload" href="./assets/shared.js"><template data-openclaw-route-preloads="chat"><link rel="modulepreload" crossorigin href="./assets/chat.js"></template><template data-openclaw-route-preloads="new"><link rel="modulepreload" crossorigin href="./assets/new.js"></template></head><body></body></html>`;
      const rootPath = await createControlUiRoot(html);
      const mount = basePath.replace(/\/$/, "");
      const cases = [
        ["/chat", "chat"],
        ["/chat/main/session-ref?view=thread", "chat"],
        ["/new/", "new"],
        ["/", null],
        ["/dashboard/main/session-ref", null],
        ["/approve/request-id", null],
        ["/share/chat/main/session-ref", null],
        ["/chatty", null],
        ["/new/unknown", null],
      ] as const;
      for (const [pathname, route] of cases) {
        const { handled, res, end, setHeader } = await runControlUiRequest({
          url: `${mount}${pathname}`,
          method: "GET",
          rootPath,
          rootKind: "bundled",
          basePath,
        });
        expect(handled, pathname).toBe(true);
        expect(res.statusCode, pathname).toBe(200);
        const body = responseBody(end);
        expect(body, pathname).not.toContain("data-openclaw-route-preloads");
        const preloads = Array.from(
          body.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g),
          (match) => match[1],
        );
        expect(preloads, pathname).toEqual(
          pathname.startsWith("/share/")
            ? []
            : [`${mount}/assets/shared.js`, ...(route ? [`${mount}/assets/${route}.js`] : [])],
        );
        if (!pathname.startsWith("/share/")) {
          expect(body, pathname).toContain(`<script>${script}</script>`);
          const csp = setHeader.mock.calls.findLast(
            ([header]) => header === "Content-Security-Policy",
          )?.[1];
          const hash = createHash("sha256").update(script, "utf8").digest("base64");
          expect(csp, pathname).toContain(`'sha256-${hash}'`);
        }
      }
    },
  );

  it("exposes only the environment identity on public HTML while bootstrap stays authenticated", async () => {
    const tmp = await createControlUiRoot("<html><head></head><body>Hello</body></html>\n");

    const config: OpenClawConfig = {
      gateway: { controlUi: { environment: { label: "edge & team", color: "amber" } } },
    };
    const auth = tokenAuth;
    const documentResponse = await runControlUiRequest(tmp, "/", { config, auth });
    expect(documentResponse.res.statusCode).toBe(200);
    expect(responseBody(documentResponse.end)).toContain(
      'data-openclaw-environment="{&quot;label&quot;:&quot;edge &amp; team&quot;,&quot;color&quot;:&quot;amber&quot;}"',
    );

    const bootstrapResponse = await runBootstrapConfigRequest({ rootPath: tmp, config, auth });
    expect(bootstrapResponse.res.statusCode).toBe(401);
  });

  it("anchors absolute and Vite-relative assets from a base-mounted focus route", async () => {
    const basePath = "/openclaw";
    const assets = [
      ["index.js", "index-js", "application/javascript; charset=utf-8"],
      ["index.css", "index-css", "text/css; charset=utf-8"],
    ] as const;
    const tmp = await createControlUiRoot(
      '<html><link href="/manifest.webmanifest"><link href="./favicon.svg">' +
        '<link href="./assets/index.css"><script src="./assets/index.js"></script></html>',
    );
    for (const [filename, body] of assets) {
      await writeAssetFile(tmp, filename, body);
    }
    const page = await runControlUiRequest(tmp, `${basePath}/focus/desktop/control`, { basePath });
    expect(page.handled).toBe(true);
    const body = responseBody(page.end);
    expect(body).toContain('data-openclaw-control-ui-base-path="/openclaw"');
    expect(body).toContain('href="/openclaw/manifest.webmanifest"');
    expect(body).toContain('href="/openclaw/favicon.svg"');
    expect(body).toContain('src="/openclaw/assets/index.js"');
    expect(body).toContain('href="/openclaw/assets/index.css"');
    expect(body).not.toContain('="./');
    for (const [filename, content, contentType] of assets) {
      const asset = await runControlUiRequest(tmp, `${basePath}/assets/${filename}`, { basePath });
      expect(asset.handled).toBe(true);
      expect(responseBody(asset.end)).toBe(content);
      expect(asset.setHeader).toHaveBeenCalledWith("Content-Type", contentType);
    }
  });

  it("keeps a maximum-size local avatar out of base-mounted bootstrap", async () => {
    const basePath = "/openclaw";
    const tmp = await createControlUiRoot();
    const avatar = Buffer.concat([REAL_PNG, Buffer.alloc(AVATAR_MAX_BYTES - REAL_PNG.length)]);
    await fs.writeFile(path.join(tmp, "avatar.png"), avatar);
    const config = createAvatarConfig(tmp, "avatar.png");
    const auth = { mode: "token" as const, token: "test-token", allowTailscale: false };
    const headers = { authorization: "Bearer test-token" };
    const request = { rootPath: tmp, basePath, auth, headers, config };
    const { res, end } = await runBootstrapConfigRequest(request);
    expect(res.statusCode).toBe(200);
    const parsed = parseBootstrapPayload(end);
    expect(responseBody(end).length).toBeLessThan(4096);
    expect(parsed.assistantAvatar).toMatch(new RegExp(`^${basePath}/avatar/main\\?v=[a-f0-9]+$`));
    const denied = await runAvatarRequest({
      url: parsed.assistantAvatar,
      basePath,
      config,
      auth,
    });
    expect(denied.res.statusCode).toBe(401);
    const image = await runAvatarRequest({
      url: parsed.assistantAvatar,
      basePath,
      config,
      auth,
      headers,
    });
    expect(image.res.statusCode).toBe(200);
    const imageBytes = image.end.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(imageBytes)).toBe(true);
    expect(imageBytes?.length).toBeLessThan(4096);
    const unchanged = await runBootstrapConfigRequest(request);
    expect(parseBootstrapPayload(unchanged.end).assistantAvatar).toBe(parsed.assistantAvatar);
    const replacementPath = path.join(tmp, "replacement.png");
    const previousStat = await fs.stat(path.join(tmp, "avatar.png"));
    await fs.writeFile(replacementPath, avatar);
    await fs.utimes(replacementPath, previousStat.atime, previousStat.mtime);
    await fs.rename(replacementPath, path.join(tmp, "avatar.png"));
    const replaced = await runBootstrapConfigRequest(request);
    expect(parseBootstrapPayload(replaced.end).assistantAvatar).not.toBe(parsed.assistantAvatar);
  });

  it("keeps an exact-cap IDENTITY.md data URL out of bootstrap", async () => {
    const tmp = await createControlUiRoot();
    const dataUrl = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
    expect(dataUrl).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
    await fs.writeFile(path.join(tmp, "IDENTITY.md"), `- Avatar: ${dataUrl}\n`);
    const { end, handled } = await runBootstrapConfigRequest({
      rootPath: tmp,
      config: { agents: { defaults: { workspace: tmp } } },
    });
    expect(handled).toBe(true);
    expect(parseBootstrapPayload(end)).toMatchObject({
      assistantAvatar: expect.stringMatching(/^\/avatar\/main\?v=[a-f0-9]+$/),
      assistantAvatarStatus: "data",
    });
  });

  it("rejects an over-cap IDENTITY.md avatar without truncating it", async () => {
    const tmp = await createControlUiRoot();
    const oversized = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}A`;
    expect(oversized).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + 1);
    await fs.writeFile(path.join(tmp, "IDENTITY.md"), `- Avatar: ${oversized}\n- Emoji: 🦞\n`);
    const result = await runBootstrapConfigRequest({
      rootPath: tmp,
      config: { agents: { defaults: { workspace: tmp } } },
    });
    expect(result.handled).toBe(true);
    expect(parseBootstrapPayload(result.end)).toMatchObject({
      assistantAvatar: "🦞",
      assistantAvatarSource: null,
      assistantAvatarStatus: null,
      assistantAvatarReason: null,
    });
  });

  it("does not read assistant avatar bytes for bootstrap HEAD", async () => {
    const tmp = await createControlUiRoot();
    await fs.writeFile(path.join(tmp, "avatar.png"), REAL_PNG);
    const readSync = vi.spyOn(fsSync, "readSync");
    const { res, end, handled } = await runBootstrapConfigRequest({
      rootPath: tmp,
      method: "HEAD",
      config: createAvatarConfig(tmp, "avatar.png"),
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(end).toHaveBeenCalledWith();
    expect(readSync).not.toHaveBeenCalled();
  });

  it("penalizes both credential scopes when a Control UI read token is invalid", async () => {
    await withControlUiHome("openclaw-ui-invalid-token-", async () => {
      const tmp = await createControlUiRoot();
      const rateLimiter = createAuthRateLimiterSpy();
      const { res, handled, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        auth: { mode: "token", token: "shared-token", allowTailscale: false },
        headers: { authorization: "Bearer invalid-token" },
        rateLimiter,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(responseJson(end)).toEqual({
        error: { message: "Unauthorized", type: "unauthorized" },
      });
      expect(rateLimiter.recordFailureAndDelay.mock.calls).toEqual([
        ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
        ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
      ]);
    });
  });

  it("penalizes a trusted-proxy local password mismatch only as a shared secret", async () => {
    const tmp = await createControlUiRoot();
    const rateLimiter = createAuthRateLimiterSpy();
    const { res, handled, end } = await runBootstrapConfigRequest({
      rootPath: tmp,
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        password: "local-password",
        trustedProxy: { userHeader: "x-forwarded-user" },
      },
      trustedProxies: ["127.0.0.1"],
      headers: {
        host: "localhost",
        authorization: "Bearer wrong-password",
      },
      rateLimiter,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(responseJson(end)).toEqual({
      error: { message: "Unauthorized", type: "unauthorized" },
    });
    expect(rateLimiter.recordFailureAndDelay.mock.calls).toEqual([
      ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
    ]);
  });

  it.each([
    [AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
    [AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
  ])(
    "penalizes only the unlocked credential scope when %s is locked",
    async (locked, penalized) => {
      await withControlUiHome("openclaw-ui-rate-limited-token-", async () => {
        const rateLimiter = createAuthRateLimiterSpy();
        rateLimiter.check.mockImplementation((_ip, scope) =>
          scope === locked
            ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
            : { allowed: true, remaining: 10, retryAfterMs: 0 },
        );
        const response = await runBootstrapConfigRequest({
          rootPath: await createControlUiRoot(),
          auth: { mode: "token", token: "shared-token", allowTailscale: false },
          headers: { authorization: "Bearer invalid-token" },
          rateLimiter,
        });
        expectRateLimited(response);
        expect(rateLimiter.check.mock.calls.slice(0, 2)).toEqual([
          ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
          ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
        ]);
        expect(rateLimiter.reset).not.toHaveBeenCalled();
        expect(rateLimiter.recordFailureAndDelay.mock.calls).toEqual([["127.0.0.1", penalized]]);
      });
    },
  );

  it("sets least-privilege route-bound cookies for multiple external plugin tabs", async () => {
    const tmp = await createControlUiRoot();
    const registry = createEmptyPluginRegistry();
    for (const [pluginId, route, panel, requiredScopes] of [
      ["demo-plugin", "/secure-hook", "/secure-hook", undefined],
      ["other-plugin", "/other-hook", "/other-hook/panel", ["operator.read"]],
    ] as const) {
      registry.controlUiDescriptors.push({
        pluginId,
        source: pluginId,
        descriptor: {
          surface: "tab",
          id: pluginId,
          label: pluginId,
          path: panel,
          ...(requiredScopes ? { requiredScopes: [...requiredScopes] } : {}),
        },
      });
      registry.httpRoutes.push({
        pluginId,
        source: pluginId,
        path: route,
        auth: "gateway",
        match: "prefix",
        handler: async () => true,
      });
    }
    setActivePluginRegistry(registry);

    const { res, handled, end, setHeader } = await runBootstrapConfigRequest({
      rootPath: tmp,
      auth: tokenAuth,
      headers: {
        authorization: "Bearer test-token",
      },
      config: {
        agents: { defaults: { workspace: tmp } },
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const setCookie = setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
    expect(Array.isArray(setCookie)).toBe(true);
    const cookies = Array.isArray(setCookie) ? setCookie : [];
    expect(cookies).toHaveLength(2);
    expect(parseBootstrapPayload(end).pluginFrameGrants).toEqual([
      { pluginId: "demo-plugin", path: "/secure-hook", match: "prefix" },
      { pluginId: "other-plugin", path: "/other-hook", match: "prefix" },
    ]);
    const cookieNames = cookies.map((cookie) => String(cookie).split("=", 1)[0] ?? "");
    expect(new Set(cookieNames).size).toBe(2);
    expect(
      cookieNames.every((name) =>
        /^__openclaw_plugin_tab_auth_[0-9a-f]{16}_[0-9a-f]{64}$/.test(name),
      ),
    ).toBe(true);
    expect(cookies.map(String)).toEqual([
      expect.stringContaining("Path=/secure-hook"),
      expect.stringContaining("Path=/other-hook"),
    ]);
    expect(cookies.every((cookie) => String(cookie).includes("HttpOnly"))).toBe(true);
    expect(cookies.every((cookie) => String(cookie).includes("Secure"))).toBe(true);
    expect(cookies.every((cookie) => String(cookie).includes("SameSite=None"))).toBe(true);
    const payloads = cookies.map((cookie) => {
      const encoded = String(cookie).match(new RegExp("=v1\\.([^.]+)\\."))?.[1];
      return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
    });
    expect(payloads).toMatchObject([
      {
        pluginId: "demo-plugin",
        path: "/secure-hook",
        scopes: ["operator.read"],
      },
      {
        pluginId: "other-plugin",
        path: "/other-hook",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("rejects paired device-token bootstrap when team roles cannot bind a durable person", async () => {
    await withPairedOperatorDeviceToken(async (operatorToken) => {
      const tmp = await createControlUiRoot();
      vi.spyOn(configIo, "getRuntimeConfig").mockReturnValue({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" },
                agents: ["guest"],
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      const { res, handled } = await runBootstrapConfigRequest({
        rootPath: tmp,
        auth: { mode: "token", token: "shared-token", allowTailscale: false },
        headers: { authorization: `Bearer ${operatorToken}` },
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });
  });

  it("serves paired device-token bootstrap while the shared-secret scope is locked", async () => {
    await withPairedOperatorDeviceToken(async (operatorToken) => {
      const tmp = await createControlUiRoot();
      const rateLimiter = createAuthRateLimiterSpy();
      rateLimiter.check.mockImplementation((_ip, scope) =>
        scope === AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET
          ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
          : { allowed: true, remaining: 10, retryAfterMs: 0 },
      );
      const { res, handled, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        auth: { mode: "token", token: "shared-token", allowTailscale: false },
        headers: { authorization: `Bearer ${operatorToken}` },
        rateLimiter,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(parseBootstrapPayload(end).assistantAgentId).toBeUndefined();
      expect(rateLimiter.check.mock.calls.slice(0, 2)).toEqual([
        ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
        ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
      ]);
      expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalled();
      expect(rateLimiter.reset).toHaveBeenCalledWith(
        "127.0.0.1",
        AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
      );
      expect(rateLimiter.reset).not.toHaveBeenCalledWith(
        "127.0.0.1",
        AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
      );
    });
  });

  it("rejects unattributable proxy ingress before bootstrap device-token fallback", async () => {
    const rateLimiter = createGatewayAuthRateLimiter(
      {
        maxAttempts: 2,
        windowMs: 60_000,
        lockoutMs: 60_000,
        pruneIntervalMs: 0,
      },
      { scheduler: createTestGatewayScheduler() },
    );

    try {
      await withPairedOperatorDeviceToken(async (operatorToken) => {
        const tmp = await createControlUiRoot();
        const sendBootstrap = async (token: string) =>
          await runBootstrapConfigRequest({
            rootPath: tmp,
            auth: { mode: "token", token: "shared", allowTailscale: false },
            headers: {
              authorization: `Bearer ${token}`,
              forwarded: "for=203.0.113.10",
            },
            rateLimiter,
          });

        expect((await sendBootstrap(operatorToken)).res.statusCode).toBe(403);
        expect((await sendBootstrap("wrong-one")).res.statusCode).toBe(403);
      });
    } finally {
      rateLimiter.dispose();
    }
  });

  it.each([
    ["", "/__openclaw__/control-ui-config.json"],
    ["/openclaw", "/openclaw/__openclaw/control-ui-config.json"],
  ])("serves bootstrap with basePath=%s at %s", async (basePath, url) => {
    const tmp = await createControlUiRoot();
    const { res, end, handled } = await runControlUiRequest(tmp, url, {
      basePath,
      config: {
        agents: {
          defaults: { workspace: tmp },
          list: [{ id: "main", identity: { name: "Ops", avatar: "ops.png" } }],
        },
      },
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(parseBootstrapPayload(end)).toMatchObject({
      basePath,
      assistantName: "Ops",
      assistantAvatar: "A",
      assistantAvatarStatus: "none",
      assistantAvatarReason: "missing",
      assistantAgentId: "main",
    });
  });

  it("preserves authenticated avatar HEAD metadata under a base path", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-head-");
    const body = Buffer.from("avatar 東京 avatar.svg\n", "utf8");
    await fs.writeFile(path.join(tmp, "avatar.svg"), body);
    const params = {
      url: "/openclaw/avatar/main",
      basePath: "/openclaw",
      config: createAvatarConfig(tmp, "avatar.svg"),
      auth: tokenAuth,
      headers: { authorization: "Bearer test-token" },
    };
    const head = await runAvatarRequest({ ...params, method: "HEAD" });
    expect(head.handled).toBe(true);
    expect(head.res.statusCode).toBe(200);
    expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(body.byteLength));
    expect(head.setHeader).toHaveBeenCalledWith("Content-Type", "image/svg+xml");
    expect(head.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(head.end).toHaveBeenCalledWith();
    const get = await runAvatarRequest(params);
    expect(get.res.statusCode).toBe(200);
    expect(get.end).toHaveBeenCalledWith(body);
    expect(get.setHeader).toHaveBeenCalledWith("Content-Type", "image/svg+xml");
    expect(get.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(get.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
  });

  it("does not expose avatar HEAD representation length before authentication", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-head-unauthorized-");
    await fs.writeFile(path.join(tmp, "main.png"), REAL_PNG);
    const response = await runAvatarRequest({
      url: "/avatar/main",
      method: "HEAD",
      config: createAvatarConfig(tmp, "main.png"),
      auth: tokenAuth,
    });

    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(401);
    expect(response.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
  });

  it("rejects hardlinked avatar bytes and reports matching metadata", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-http-hardlink-");
    await fs.writeFile(path.join(tmp, "original.png"), REAL_PNG);
    await fs.link(path.join(tmp, "original.png"), path.join(tmp, "avatar.png"));
    const config = createAvatarConfig(tmp, "avatar.png");

    expectNotFoundResponse(await runAvatarRequest({ url: "/avatar/main", method: "GET", config }));
    const meta = await runAvatarRequest({
      url: "/avatar/main?meta=1",
      config,
    });
    expect(meta.handled).toBe(true);
    expect(meta.res.statusCode).toBe(200);
    expect(responseJson(meta.end)).toEqual({
      avatarUrl: null,
      avatarSource: "avatar.png",
      avatarStatus: "none",
      avatarReason: "unreadable",
    });
  });

  it("rejects avatar symlink paths from resolver", async () => {
    const tmp = testTempDirs.make("openclaw-avatar-http-link-");
    const outside = testTempDirs.make("openclaw-avatar-http-outside-");
    const outsideFile = path.join(outside, "secret.txt");
    await fs.writeFile(outsideFile, "outside-secret\n");
    const linkPath = path.join(tmp, "avatar-link.png");
    await fs.symlink(outsideFile, linkPath);

    const { res, end, handled } = await runAvatarRequest({
      url: "/avatar/main",
      config: createAvatarConfig(tmp, "avatar-link.png"),
    });

    expectNotFoundResponse({ handled, res, end });
  });

  it("returns avatar metadata when auth is enabled and the token is valid", async () => {
    const { res, end, handled } = await runAvatarRequest({
      url: "/avatar/main?meta=1",
      config: createAvatarConfig(os.tmpdir(), "https://example.com/avatar.png"),
      auth: tokenAuth,
      headers: {
        authorization: "Bearer test-token",
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      avatarUrl: "https://example.com/avatar.png",
      avatarSource: "remote URL",
      avatarStatus: "remote",
      avatarReason: null,
    });
  });

  it("redacts unsafe avatar source values from metadata", async () => {
    const { res, end, handled } = await runAvatarRequest({
      url: "/avatar/main?meta=1",
      config: createAvatarConfig("/tmp/workspace", "/Users/test/private/avatar.png"),
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(responseJson(end)).toEqual({
      avatarUrl: null,
      avatarSource: null,
      avatarStatus: "none",
      avatarReason: "outside_workspace",
    });
  });

  it("rejects trusted-proxy avatar metadata requests without operator.read scope", async () => {
    expectMissingOperatorReadResponse(
      await runAvatarRequest({
        url: "/avatar/main?meta=1",
        auth: setupTrustedProxyAuth(),
        trustedProxies: ["10.0.0.1"],
        remoteAddress: "10.0.0.1",
        headers: createTrustedProxyHeaders({ "x-openclaw-scopes": "" }),
        config: createAvatarConfig(os.tmpdir(), "https://example.com/avatar.png"),
      }),
    );
  });

  it("keeps JSON-Accept requests for explicit assets and plugin recovery routes", async () => {
    const tmp = await createControlUiRoot("<html><body>plugin-recovery</body></html>\n");

    await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

    const asset = await runControlUiRequest(tmp, "/assets/actual.txt", {
      headers: { accept: "application/json" },
    });
    expect(asset.handled).toBe(true);
    expect(asset.res.statusCode).toBe(200);
    expect(responseBody(asset.end)).toBe("inside-ok\n");

    const recovery = await runControlUiRequest(tmp, "/settings/plugins", {
      headers: { accept: "application/json" },
    });
    expect(recovery.handled).toBe(true);
    expect(recovery.res.statusCode).toBe(200);
    expect(responseBody(recovery.end)).toContain("plugin-recovery");
  });

  it("serves a missing bundled asset from an exact retained generation", async () => {
    const tmp = await createControlUiRoot();
    const retainedRoot = testTempDirs.make("openclaw-ui-retained-");
    const source = "console.log('retained');\n".repeat(200);
    const { filePath } = await writeAssetFile(retainedRoot, "panel-OldBuild.js", source);
    await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
    const retainedAssets = {
      prepare: vi.fn(async () => {}),
      resolveAsset: vi.fn(() => ({
        filePath,
        rootPath: retainedRoot,
        rootRealPath: fsSync.realpathSync(retainedRoot),
      })),
    } satisfies ControlUiAssetRetention;

    const { end, setHeader } = await runControlUiRequest(tmp, "/assets/panel-OldBuild.js", {
      rootKind: "bundled",
      retainedAssets,
      headers: { "accept-encoding": "br, identity;q=0" },
    });

    expect(retainedAssets.resolveAsset).toHaveBeenCalledWith("assets/panel-OldBuild.js");
    expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "br");
    expect(brotliDecompressSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
  });

  it("falls through to an acceptable sidecar when the preferred variant is missing", async () => {
    const tmp = await createControlUiRoot();
    const source = "console.log('partial-build');\n".repeat(200);
    const { filePath } = await writeAssetFile(tmp, "app-IjKl9012.js", source);
    await fs.writeFile(`${filePath}.gz`, gzipSync(source));

    const { end, setHeader } = await runControlUiRequest(tmp, "/assets/app-IjKl9012.js", {
      rootKind: "bundled",
      headers: { "accept-encoding": "br, gzip;q=0.5, identity;q=0" },
    });

    expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
    expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toBe(source);
  });

  it("clamps future filesystem mtimes so validators cannot postdate the response", async () => {
    const tmp = await createControlUiRoot();
    const fontsDir = path.join(tmp, "fonts");
    await fs.mkdir(fontsDir, { recursive: true });
    const fontPath = path.join(fontsDir, "lora-latin.woff2");
    await fs.writeFile(fontPath, Buffer.from("wOF2-mock-bytes"));
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await fs.utimes(fontPath, future, future);

    const { res, setHeader } = await runControlUiRequest(tmp, "/fonts/lora-latin.woff2", {
      rootKind: "bundled",
    });

    expect(res.statusCode).toBe(200);
    const lastModified = setHeader.mock.calls.find(([name]) => name === "Last-Modified")?.[1];
    expect(typeof lastModified).toBe("string");
    const emitted = Date.parse(lastModified as string);
    // A future validator would 304 later replacements; it must never
    // postdate the response, only trail it by clock/floor slack.
    expect(emitted).toBeLessThanOrEqual(Date.now());
    expect(emitted).toBeLessThan(future.getTime());
  });

  it("returns 406 when no available asset representation is acceptable", async () => {
    const tmp = await createControlUiRoot();
    await writeAssetFile(tmp, "app-settings.js", "console.log('configured');\n");

    const { res, end } = await runControlUiRequest(tmp, "/assets/app-settings.js", {
      headers: { "accept-encoding": "br;q=0, gzip;q=0, identity;q=0" },
    });

    expect(res.statusCode).toBe(406);
    expect(responseBody(end)).toBe("Not Acceptable");
  });

  it("does not expose precompressed sidecars as independent assets", async () => {
    const tmp = await createControlUiRoot();
    const { filePath } = await writeAssetFile(tmp, "app-AbCd1234.js", "source\n");
    await fs.writeFile(`${filePath}.br`, brotliCompressSync("source\n"));

    const { res, end, handled } = await runControlUiRequest(tmp, "/assets/app-AbCd1234.js.br", {
      rootKind: "bundled",
    });

    expectNotFoundResponse({ handled, res, end });
  });

  it("preserves standalone compressed files in configured roots", async () => {
    const tmp = await createControlUiRoot();
    await writeAssetFile(tmp, "data.gz", "configured-compressed-artifact\n");

    const { end, handled, setHeader } = await runControlUiRequest(tmp, "/assets/data.gz", {
      headers: { "accept-encoding": "br;q=0, gzip;q=0.8" },
    });

    expect(handled).toBe(true);
    expect(responseBody(end)).toBe("configured-compressed-artifact\n");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(setHeader).not.toHaveBeenCalledWith("Content-Encoding", expect.anything());
  });

  it("compresses prepared SPA fallback HTML", async () => {
    const tmp = await createControlUiRoot(`<html><body>${"hello ".repeat(200)}</body></html>\n`);
    const params = { headers: { "accept-encoding": "gzip" } };
    const first = await runControlUiRequest(tmp, "/chat", params);
    const { end, setHeader } = await runControlUiRequest(tmp, "/chat", params);
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
    expect(gunzipSync(end.mock.calls[0]?.[0] as Buffer).toString()).toContain(
      '<html data-openclaw-control-ui-base-path="" data-openclaw-terminal-enabled="true">',
    );
    expect(end.mock.calls[0]?.[0]).toEqual(first.end.mock.calls[0]?.[0]);
  });

  it("returns 406 when every HTML representation is explicitly rejected", async () => {
    const { res, end } = await runControlUiRequest(await createControlUiRoot(), "/", {
      headers: { "accept-encoding": "*;q=0" },
    });
    expect(res.statusCode).toBe(406);
    expect(responseBody(end)).toBe("Not Acceptable");
  });

  it("rejects malformed encoding weights and preserves negotiated HEAD byte length", async () => {
    const tmp = await createControlUiRoot();
    const source = "console.log('static asset metadata');\n".repeat(12);
    const { filePath } = await writeAssetFile(tmp, "app-HeAd1234.js", source);
    await fs.writeFile(`${filePath}.gz`, gzipSync(source));
    await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
    const request = {
      rootKind: "bundled" as const,
      headers: {
        "accept-encoding": "br;q=0.8junk, gzip;q=0.5, identity;q=0",
      },
    };
    const get = await runControlUiRequest(tmp, "/assets/app-HeAd1234.js", {
      ...request,
      method: "GET",
    });
    const head = await runControlUiRequest(tmp, "/assets/app-HeAd1234.js", {
      ...request,
      method: "HEAD",
    });
    const body = get.end.mock.calls[0]?.[0];

    expect(Buffer.isBuffer(body)).toBe(true);
    expect(gunzipSync(body).toString()).toBe(source);
    expect(get.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    expect(get.setHeader).toHaveBeenCalledWith("Vary", "Accept-Encoding");
    expect(head.setHeader).toHaveBeenCalledWith("Content-Length", String(body.byteLength));
    expect(head.end.mock.calls[0]?.length ?? -1).toBe(0);
    expect(head.setHeader).toHaveBeenCalledWith("Content-Encoding", "gzip");
  });

  it("serves an asset-like Unicode approval ID through the standalone document", async () => {
    const basePath = "/openclaw";
    const url =
      "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E.json";
    const tmp = await createControlUiRoot("<html><body>standalone-spa</body></html>\n");

    for (const method of ["GET", "HEAD"] as const) {
      const { res, end, handled } = await runControlUiRequest(tmp, url, { method, basePath });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      if (method === "HEAD") {
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
      } else {
        expect(responseBody(end)).toContain("standalone-spa");
        expect(responseBody(end)).toContain('data-openclaw-control-ui-base-path="/openclaw"');
      }
    }
  });

  it("rejects symlinked SPA fallback index.html outside control-ui root", async () => {
    const tmp = await createControlUiRoot();
    const outsideDir = testTempDirs.make("openclaw-ui-index-outside-");
    const outsideIndex = path.join(outsideDir, "index.html");
    await fs.writeFile(outsideIndex, "<html>outside</html>\n");
    await fs.rm(path.join(tmp, "index.html"));
    await fs.symlink(outsideIndex, path.join(tmp, "index.html"));

    const { res, end, handled } = await runControlUiRequest(tmp, "/app/route");
    expectNotFoundResponse({ handled, res, end });
  });

  it("serves public root assets under the internal namespace", async () => {
    const tmp = await createControlUiRoot();
    await fs.writeFile(path.join(tmp, "favicon.svg"), "<svg/>");
    const { res, end, handled, setHeader } = await runControlUiRequest(
      tmp,
      "/__openclaw__/favicon.svg",
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "image/svg+xml");
    expect(responseBody(end)).toBe("<svg/>");
  });

  it("does not handle /api paths when basePath is empty", async () => {
    const tmp = await createControlUiRoot();
    for (const apiPath of ["/api", "/api/sessions", "/api/channels/nostr"]) {
      const { handled } = await runControlUiRequest(tmp, apiPath);
      expect(handled, `expected ${apiPath} to not be handled`).toBe(false);
    }
  });

  it("does not handle plugin HTTP descendants when basePath is empty", async () => {
    const { handled } = await runControlUiRequest(
      await createControlUiRoot(),
      "/plugins/diffs/view/abc/def",
    );
    expect(handled).toBe(false);
  });

  it("falls through POST requests when basePath is empty", async () => {
    const tmp = await createControlUiRoot();
    const { handled, end } = await runControlUiRequest(tmp, "/webhook/imessage", {
      method: "POST",
    });
    expect(handled).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });

  it("falls through POST requests under configured basePath", async () => {
    const { handled, end } = await runControlUiRequest(
      await createControlUiRoot(),
      "/openclaw/some-page",
      { method: "POST", basePath: "/openclaw" },
    );
    expect(handled).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });

  it("rejects absolute-path escape attempts under basePath routes", async () => {
    const { root, sibling } = await createBasePathRootFixture();
    const secretPath = path.join(sibling, "secret.txt");
    await fs.writeFile(secretPath, "sensitive-data");
    const secretUrl = secretPath.split(path.sep).join("/");
    expectNotFoundResponse(
      await runControlUiRequest(
        root,
        `/openclaw/${secretUrl.startsWith("/") ? secretUrl : `/${secretUrl}`}`,
        { basePath: "/openclaw" },
      ),
    );
  });

  it("rejects symlink escape attempts under basePath routes", async () => {
    const { root, sibling } = await createBasePathRootFixture();
    await fs.mkdir(path.join(root, "assets"));
    const secretPath = path.join(sibling, "secret.txt");
    await fs.writeFile(secretPath, "sensitive-data");
    await fs.symlink(secretPath, path.join(root, "assets", "leak.txt"), "file");
    expectNotFoundResponse(
      await runControlUiRequest(root, "/openclaw/assets/leak.txt", { basePath: "/openclaw" }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
