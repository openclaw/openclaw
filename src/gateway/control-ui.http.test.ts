import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNoisyPngBuffer, createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as identityFiles from "../agents/identity-file.js";
import * as configIo from "../config/io.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createImageProcessor } from "../media/image-processor.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-limits.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  createGatewayAuthRateLimiter,
} from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
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
import { ANIMATED_GIF_BYTES, APNG_BYTES } from "./http-image.test-support.js";
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
  return { ...actual, resolvePlaybackTranscode: resolvePlaybackTranscodeMock };
});

const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenAuth = { mode: "token", token: "test-token", allowTailscale: false } as const;
const sharedAuth = { ...tokenAuth, token: "shared-token" };

beforeEach(() => setRuntimeConfigSnapshot({}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  resetPluginRuntimeStateForTest();
  resolvePlaybackTranscodeMock.mockReset();
  resolvePlaybackTranscodeMock.mockResolvedValue({ kind: "passthrough" });
});

function createAvatarConfig(workspace: string, avatar: string): OpenClawConfig {
  return { agents: { entries: { main: { workspace, identity: { avatar } } } } };
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

function expectStatus(result: { handled: boolean; res: ServerResponse }, code = 200) {
  expect(result).toMatchObject({ handled: true, res: { statusCode: code } });
}

function expectNotFoundResponse(params: {
  handled: boolean;
  res: ReturnType<typeof makeMockHttpResponse>["res"];
  end: ReturnType<typeof makeMockHttpResponse>["end"];
}) {
  expectStatus(params, 404);
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
  return {
    ...response,
    handled,
    headers: Object.fromEntries(
      response.setHeader.mock.calls.map(([name, value]): [string, unknown] => [
        String(name),
        value,
      ]),
    ),
    body: response.end.mock.calls[0]?.[0],
    text: String(response.end.mock.calls[0]?.[0] ?? ""),
  };
}

type ControlRequestParams = RequestParams &
  Omit<NonNullable<Parameters<typeof handleControlUiHttpRequest>[2]>, "root"> & {
    rootPath: string;
    rootKind?: "resolved" | "bundled";
  };

function runControlUiRequest(
  rootPath: string,
  url: string,
  { rootKind = "resolved", ...params }: Omit<ControlRequestParams, "url" | "rootPath"> = {},
) {
  if (params.config) {
    setRuntimeConfigSnapshot(params.config);
  }
  return runRequest(
    handleControlUiHttpRequest,
    { ...params, url },
    { ...params, root: { kind: rootKind, path: rootPath } },
  );
}

async function runBootstrapConfigRequest({
  rootPath,
  ...params
}: Omit<ControlRequestParams, "url" | "rootPath"> & { rootPath?: string }) {
  return runControlUiRequest(
    rootPath ?? (await createControlUiRoot()),
    `${params.basePath ?? ""}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
    params,
  );
}

function runAvatarRequest(params: RequestParams & AuthParams & { config: OpenClawConfig }) {
  setRuntimeConfigSnapshot(params.config);
  return runRequest(handleControlUiAvatarRequest, params, params);
}

function readMedia(
  source: string,
  query = "token=test-token",
  params: Omit<RequestParams, "url"> & AuthParams = {},
) {
  return runRequest(
    handleControlUiAssistantMediaRequest,
    {
      ...params,
      url: `/__openclaw__/assistant-media?source=${encodeURIComponent(source)}&${query}`,
    },
    { ...params, auth: params.auth ?? tokenAuth },
  );
}

async function runTrustedProxyAssistantMediaRequest(params: {
  filePath: string;
  headers?: IncomingMessage["headers"];
}) {
  return await readMedia(params.filePath, "", {
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
  expectStatus(params, 403);
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

function lockedRateLimiter(locked: string) {
  const limiter = createAuthRateLimiterSpy();
  limiter.check.mockImplementation((_ip, scope) =>
    scope === locked
      ? { allowed: false, remaining: 0, retryAfterMs: 2_500 }
      : { allowed: true, remaining: 10, retryAfterMs: 0 },
  );
  return limiter;
}

function expectRateLimited(result: Awaited<ReturnType<typeof runBootstrapConfigRequest>>) {
  expectStatus(result, 429);
  expect(responseJson(result.end)).toEqual({
    error: {
      message: "Too many failed authentication attempts. Please try again later.",
      type: "rate_limited",
    },
  });
  expect(result.headers).toMatchObject({ "Retry-After": "3" });
}

async function writeFile(root: string, name: string, contents: string | Buffer) {
  const filePath = path.join(root, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
  return filePath;
}

const writeAssetFile = (root: string, name: string, contents: string) =>
  writeFile(root, `assets/${name}`, contents);

const createMediaFile = (name = "photo.png", bytes: string | Buffer = "not-a-real-png") =>
  writeFile(testTempDirs.make("ui-media-", resolvePreferredOpenClawTmpDir()), name, bytes);

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
  await writeFile(root, "index.html", "<html>ok</html>\n");
  const secretPath = await writeFile(path.join(tmp, "outside"), "secret.txt", "sensitive-data");
  return { root, secretPath };
}

function withControlUiHome<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  return withOpenClawTestState({ prefix, scenario: "empty" }, async () => {
    setRuntimeConfigSnapshot({});
    return fn();
  });
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
      ...(issuerGeneration ? { clientId: "openclaw-control-ui", clientMode: "webchat" } : {}),
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
        issuer: { kind: "shared-gateway-auth", generation: issuerGeneration },
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

  const reply = await runControlUiRequest(tmp, "/", {
    headers: { host: "gateway.example.test" },
  });
  expect(reply.handled).toBe(true);
  expect(reply.headers).toMatchObject({ "X-Frame-Options": "DENY" });
  const csp = reply.headers["Content-Security-Policy"];
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
  expect(reply.headers).toMatchObject({
    "Permissions-Policy": "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
  });
  expect(reply.text).toContain('data-openclaw-terminal-enabled="true"');
});

it("uses effective terminal availability instead of raw restart-pending config", async () => {
  const tmp = await createControlUiRoot();
  const reply = await runControlUiRequest(tmp, "/", {
    headers: { host: "gateway.example.test" },
    config: { gateway: { terminal: { enabled: true } } },
    terminalEnabled: false,
  });
  const csp = reply.headers["Content-Security-Policy"];
  expect(String(csp)).not.toContain("'wasm-unsafe-eval'");
  expect(reply.text).toContain('data-openclaw-terminal-enabled="false"');

  const bootstrap = await runControlUiRequest(tmp, CONTROL_UI_BOOTSTRAP_CONFIG_PATH, {
    config: { gateway: { terminal: { enabled: false } } },
    terminalEnabled: true,
  });
  expect(parseBootstrapPayload(bootstrap.end).terminalEnabled).toBe(true);
});

it.each([
  ["gif", ANIMATED_GIF_BYTES, "image/gif"],
  ["png", APNG_BYTES, "image/png"],
  [
    "webp",
    Buffer.from(
      "UklGRuQAAABXRUJQVlA4WAoAAAACAAAAFwAAFwAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABcAAFAAAAJWUDggQAAAAHADAJ0BKhgAGAA+bTSWR6QjIiEoCACADYllAMougH4AAEGUEAD+8JtD/8guWF1yNf/yA/5Af8gP/499jCgwAABBTk1GWAAAAAAAAAAAABcAABcAAHgAAABWUDggQAAAAFQDAJ0BKhgAGAA+bTKWR4KAgAAA2JZQC/ZoB+AH4AAETfZgAP7lhz/9rQHBqv8z//998KI7df5tQBnBY0gAAAA=",
      "base64",
    ),
    "image/webp",
  ],
] as const)(
  "preserves legacy local %s animation bytes for preview requests",
  async (extension, bytes, mimeType) => {
    const filePath = await createMediaFile("animation." + extension, bytes);
    const response = await readMedia(filePath, "token=test-token&variant=thumbnail&width=480");
    expect(response.res.statusCode).toBe(200);
    expect(response.headers).toMatchObject({ "Content-Type": mimeType });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      response.res.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.res.once("end", resolve);
      response.res.once("error", reject);
    });
    expect(Buffer.concat(chunks)).toEqual(bytes);
  },
);

it("serves a bounded inbound photo preview without replacing its original", async () => {
  const state = testTempDirs.make("inbound-preview-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: state }, async () => {
    const bytes = createNoisyPngBuffer(600, 300);
    const photoPath = await writeFile(state, "media/inbound/photo.png", bytes);
    const modified = new Date("2025-01-01T00:00:00.000Z");
    await fs.utimes(photoPath, modified, modified);
    const source = "media://inbound/photo.png";
    const read = (query = "variant=thumbnail", method: "GET" | "HEAD" = "GET") =>
      readMedia(source, `token=test-token&${query}`, { method });
    const preview = await read();
    expect(preview.res.statusCode).toBe(200);
    const body = preview.body;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(preview.headers).toMatchObject({ "Content-Type": "image/webp" });
    expect(body.byteLength).toBeLessThan(bytes.byteLength);
    expect(await createImageProcessor().probe(body)).toMatchObject({
      format: "webp",
      width: 600,
      height: 300,
    });
    const small = await read("variant=thumbnail&width=480");
    expect(await createImageProcessor().probe(small.body)).toMatchObject({
      format: "webp",
      width: 240,
      height: 120,
    });
    const head = await read("variant=thumbnail", "HEAD");
    expect(head.headers).toMatchObject({ "Content-Length": String(body.byteLength) });
    expect(head.end).toHaveBeenCalledWith(undefined);
    const original = await read("", "HEAD");
    expect(original.headers).toMatchObject({ "Content-Length": String(bytes.byteLength) });
    expect(await fs.readFile(photoPath)).toEqual(bytes);
    const solid = createSolidPngBuffer(600, 300, { r: 20, g: 40, b: 60 });
    // PNG decoders ignore trailing bytes; pad this fixture to preserve the source size.
    const replacement = Buffer.concat([solid, Buffer.alloc(bytes.byteLength - solid.byteLength)]);
    await fs.writeFile(photoPath, replacement);
    await fs.utimes(photoPath, modified, modified);
    const refreshed = await read();
    expect(refreshed.res.statusCode).toBe(200);
    expect(refreshed.body).not.toEqual(body);
  });
});

it("serves fresh media after an in-place rewrite preserves size and mtime", async () => {
  const original = Buffer.from("original media bytes");
  const filePath = await createMediaFile("sample.bin", original);
  const replacement = Buffer.from("replaced media bytes");
  const modified = new Date("2025-01-01T00:00:00.000Z");
  await fs.utimes(filePath, modified, modified);
  const read = (method: "GET" | "HEAD", conditions: IncomingMessage["headers"] = {}) =>
    readMedia(filePath, "", {
      method,
      headers: { authorization: "Bearer test-token", ...conditions },
    });
  const initial = await read("HEAD");
  const etag = typeof initial.headers.ETag === "string" ? initial.headers.ETag : '"cached-version"';
  const lastModified = modified.toUTCString();
  await fs.writeFile(filePath, replacement);
  await fs.utimes(filePath, modified, modified);
  const stat = await fs.stat(filePath);
  expect(stat).toMatchObject({ size: original.length, mtimeMs: modified.getTime() });
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
  expect(ranged.headers).toMatchObject({ "Content-Range": `bytes 0-3/${replacement.length}` });
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
  const reply = await readMedia(filePath, "playback=1&token=test-token");

  expectStatus(reply, 202);
  expect(responseJson(reply.end)).toEqual({ status: "preparing" });
});

it("caps and encodes Unicode assistant media filenames without splitting surrogate pairs", async () => {
  const filename = `${"a".repeat(176)}测试 100% 'draft' (1)😀${"b".repeat(20)}.pdf`;
  const filePath = await createMediaFile(filename, "fixture");
  const reply = await readMedia(filePath);
  expectStatus(reply);
  expect(reply.res["setHeader"]).toHaveBeenCalledWith(
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
  const reply = await readMedia(filePath);
  expectNotFoundResponse(reply);
});

it("fully reads the served assistant media MIME prefix after a short read", async () => {
  const filePath = await createMediaFile("photo.bin", REAL_PNG);
  const readSpy = await forceFirstFileHandleShortRead(filePath, 1);

  const reply = await readMedia(filePath);

  expectStatus(reply);
  expect(reply.headers).toMatchObject({ "Content-Type": "image/png" });
  expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("reports assistant media metadata when the process clock is outside the Date range", async () => {
  using _ = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
  const filePath = await createMediaFile();
  const reply = await readMedia(filePath, "meta=1&token=test-token");
  expectStatus(reply);
  const payload = responseJson(reply.end);
  expect(payload).toMatchObject({ available: true });
  expect(payload).not.toHaveProperty("mediaTicket");
  expect(payload).not.toHaveProperty("mediaTicketExpiresAt");
});

it("reports assistant local media availability failures with a reason", async () => {
  const reply = await readMedia("/Users/test/Documents/private.pdf", "meta=1&token=test-token");
  expectStatus(reply);
  expect(responseJson(reply.end)).toEqual({
    available: false,
    code: "outside-allowed-folders",
    reason: "Outside allowed folders",
    retryable: false,
    canAllow: true,
  });
});

it("accepts shared-gateway issuer tagged device tokens on assistant media requests", async () => {
  const auth = sharedAuth;
  const issuerGeneration = resolveSharedGatewaySessionGeneration(auth);
  expect(typeof issuerGeneration).toBe("string");
  await withPairedOperatorDeviceToken(async (operatorToken) => {
    const filePath = await createMediaFile();
    const reply = await readMedia(filePath, `token=${encodeURIComponent(operatorToken)}`, {
      auth,
    });
    expectStatus(reply);
  }, issuerGeneration);
});

it("rejects trusted-proxy assistant media requests from disallowed browser origins", async () => {
  const filePath = await createMediaFile();
  const reply = await runTrustedProxyAssistantMediaRequest({
    filePath,
    headers: { origin: "https://evil.example" },
  });
  expectStatus(reply, 401);
  expect(reply.text).toContain("Unauthorized");
});

it("rejects trusted-proxy assistant media file reads without operator.read scope", async () => {
  const filePath = await createMediaFile();
  const reply = await runTrustedProxyAssistantMediaRequest({
    filePath,
    headers: { "x-openclaw-scopes": "operator.approvals" },
  });
  expectMissingOperatorReadResponse(reply);
});

it.each(["/openclaw/"])(
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
      const reply = await runControlUiRequest(rootPath, `${mount}${pathname}`, {
        method: "GET",
        rootKind: "bundled",
        basePath,
      });
      expect(reply.handled, pathname).toBe(true);
      expect(reply.res.statusCode, pathname).toBe(200);
      const body = reply.text;
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
        const csp = reply.headers["Content-Security-Policy"];
        const hash = createHash("sha256").update(script, "utf8").digest("base64");
        expect(csp, pathname).toContain(`'sha256-${hash}'`);
      }
    }
  },
);

it("embeds authorized display preferences without config credentials in the document", async () => {
  const tmp = await createControlUiRoot("<html><head></head><body>Control UI</body></html>");
  const config: OpenClawConfig = {
    ui: { prefs: { locale: "de", themeMode: "light" } },
    mcp: { servers: { fixture: { url: "https://example.test/mcp?api_key=synthetic-secret" } } },
  };
  const response = await runControlUiRequest(tmp, "/", {
    config,
    auth: tokenAuth,
    headers: { authorization: "Bearer test-token" },
  });
  expect(response.res.statusCode).toBe(200);
  const body = response.text;
  expect(body).toContain("data-openclaw-bootstrap-config=");
  expect(body).toContain("&quot;locale&quot;:&quot;de&quot;");
  expect(body).toContain("&quot;themeMode&quot;:&quot;light&quot;");
  expect(body).not.toContain("synthetic-secret");
  expect(response.headers).toMatchObject({ "Cache-Control": "private, no-store" });
});

it("exposes only the environment identity on public HTML while bootstrap stays authenticated", async () => {
  const tmp = await createControlUiRoot("<html><head></head><body>Hello</body></html>\n");

  const config: OpenClawConfig = {
    gateway: { controlUi: { environment: { label: "edge & team", color: "amber" } } },
    agents: {
      entries: {
        main: {
          workspace: tmp,
          identity: { name: "</script><script>alert(1)//", avatar: "evil.png" },
        },
      },
    },
  };
  const auth = tokenAuth;
  const documentResponse = await runControlUiRequest(tmp, "/", { config, auth });
  expect(documentResponse.res.statusCode).toBe(200);
  expect(documentResponse.text).toContain(
    'data-openclaw-environment="{&quot;label&quot;:&quot;edge &amp; team&quot;,&quot;color&quot;:&quot;amber&quot;}"',
  );
  expect(documentResponse.text).not.toMatch(/<script|alert\(1\)|evil\.png/);

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
  const body = page.text;
  expect(body).toContain('data-openclaw-control-ui-base-path="/openclaw"');
  expect(body).toContain('href="/openclaw/manifest.webmanifest"');
  expect(body).toContain('href="/openclaw/favicon.svg"');
  expect(body).toContain('src="/openclaw/assets/index.js"');
  expect(body).toContain('href="/openclaw/assets/index.css"');
  expect(body).not.toContain('="./');
  for (const [filename, content, contentType] of assets) {
    const asset = await runControlUiRequest(tmp, `${basePath}/assets/${filename}`, { basePath });
    expect(asset.handled).toBe(true);
    expect(asset.text).toBe(content);
    expect(asset.headers).toMatchObject({ "Content-Type": contentType });
  }
});

it("keeps a maximum-size local avatar out of base-mounted bootstrap", async () => {
  const basePath = "/openclaw";
  const tmp = await createControlUiRoot();
  const avatar = Buffer.concat([REAL_PNG, Buffer.alloc(AVATAR_MAX_BYTES - REAL_PNG.length)]);
  await fs.writeFile(path.join(tmp, "avatar.png"), avatar);
  const config = createAvatarConfig(tmp, "avatar.png");
  const auth = tokenAuth;
  const headers = { authorization: "Bearer test-token" };
  const request = { rootPath: tmp, basePath, auth, headers, config };
  const reply = await runBootstrapConfigRequest(request);
  expect(reply.res.statusCode).toBe(200);
  const parsed = parseBootstrapPayload(reply.end);
  expect(reply.text.length).toBeLessThan(4096);
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
  const imageBytes = image.body;
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

it.each(["", "A"])(
  "handles cap suffix %j without embedding or truncating IDENTITY.md avatars",
  async (extra) => {
    const tmp = await createControlUiRoot();
    const avatar = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}${extra}`;
    expect(avatar).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + extra.length);
    await fs.writeFile(
      path.join(tmp, "IDENTITY.md"),
      `- Avatar: ${avatar}\n${extra ? "- Emoji: 🦞\n" : ""}`,
    );
    const result = await runBootstrapConfigRequest({
      rootPath: tmp,
      config: { agents: { defaults: { workspace: tmp } } },
    });
    expect(result.handled).toBe(true);
    expect(parseBootstrapPayload(result.end)).toMatchObject(
      extra
        ? {
            assistantAvatar: "🦞",
            assistantAvatarSource: null,
            assistantAvatarStatus: null,
            assistantAvatarReason: null,
          }
        : {
            assistantAvatar: expect.stringMatching(/^\/avatar\/main\?v=[a-f0-9]+$/),
            assistantAvatarStatus: "data",
          },
    );
  },
);

it("does not read assistant avatar bytes for bootstrap HEAD", async () => {
  const tmp = await createControlUiRoot();
  await fs.writeFile(path.join(tmp, "avatar.png"), REAL_PNG);
  const readSync = vi.spyOn(fsSync, "readSync");
  const reply = await runBootstrapConfigRequest({
    rootPath: tmp,
    method: "HEAD",
    config: createAvatarConfig(tmp, "avatar.png"),
  });
  expectStatus(reply);
  expect(reply.end).toHaveBeenCalledOnce();
  expect(reply.text).toBe("");
  expect(readSync).not.toHaveBeenCalled();
});

it("penalizes both credential scopes when a Control UI read token is invalid", async () => {
  await withControlUiHome("openclaw-ui-invalid-token-", async () => {
    const rateLimiter = createAuthRateLimiterSpy();
    const reply = await runBootstrapConfigRequest({
      auth: sharedAuth,
      headers: { authorization: "Bearer invalid-token" },
      rateLimiter,
    });

    expectStatus(reply, 401);
    expect(responseJson(reply.end)).toEqual({
      error: { message: "Unauthorized", type: "unauthorized" },
    });
    expect(rateLimiter.recordFailureAndDelay.mock.calls).toEqual([
      ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
      ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
    ]);
  });
});

it("penalizes a trusted-proxy local password mismatch only as a shared secret", async () => {
  const rateLimiter = createAuthRateLimiterSpy();
  const reply = await runBootstrapConfigRequest({
    auth: {
      mode: "trusted-proxy",
      allowTailscale: false,
      password: "local-password",
      trustedProxy: { userHeader: "x-forwarded-user" },
    },
    trustedProxies: ["127.0.0.1"],
    headers: { host: "localhost", authorization: "Bearer wrong-password" },
    rateLimiter,
  });

  expectStatus(reply, 401);
  expect(responseJson(reply.end)).toEqual({
    error: { message: "Unauthorized", type: "unauthorized" },
  });
  expect(rateLimiter.recordFailureAndDelay.mock.calls).toEqual([
    ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
  ]);
});

it.each([
  [AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
  [AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
])("penalizes only the unlocked credential scope when %s is locked", async (locked, penalized) => {
  await withControlUiHome("openclaw-ui-rate-limited-token-", async () => {
    const rateLimiter = lockedRateLimiter(locked);
    const response = await runBootstrapConfigRequest({
      auth: sharedAuth,
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
});

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

  const reply = await runBootstrapConfigRequest({
    rootPath: tmp,
    auth: tokenAuth,
    headers: { authorization: "Bearer test-token" },
    config: { agents: { defaults: { workspace: tmp } } },
  });

  expectStatus(reply);
  const setCookie = reply.headers["Set-Cookie"];
  expect(Array.isArray(setCookie)).toBe(true);
  const cookies = Array.isArray(setCookie) ? setCookie : [];
  expect(cookies).toHaveLength(2);
  expect(parseBootstrapPayload(reply.end).pluginFrameGrants).toEqual([
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
  for (const attribute of ["HttpOnly", "Secure", "SameSite=None"]) {
    expect(cookies.every((cookie) => String(cookie).includes(attribute))).toBe(true);
  }
  const payloads = cookies.map((cookie) => {
    const encoded = String(cookie).match(new RegExp("=v1\\.([^.]+)\\."))?.[1];
    return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
  });
  expect(payloads).toMatchObject([
    { pluginId: "demo-plugin", path: "/secure-hook", scopes: ["operator.read"] },
    { pluginId: "other-plugin", path: "/other-hook", scopes: ["operator.read"] },
  ]);
});

it("rejects paired device-token bootstrap when team roles cannot bind a durable person", async () => {
  await withPairedOperatorDeviceToken(async (operatorToken) => {
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
    const reply = await runBootstrapConfigRequest({
      auth: sharedAuth,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expectStatus(reply, 401);
  });
});

it("serves paired device-token bootstrap while the shared-secret scope is locked", async () => {
  await withPairedOperatorDeviceToken(async (operatorToken) => {
    const rateLimiter = lockedRateLimiter(AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
    const reply = await runBootstrapConfigRequest({
      auth: sharedAuth,
      headers: { authorization: `Bearer ${operatorToken}` },
      rateLimiter,
    });

    expectStatus(reply);
    expect(parseBootstrapPayload(reply.end).assistantAgentId).toBeUndefined();
    expect(rateLimiter.check.mock.calls.slice(0, 2)).toEqual([
      ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET],
      ["127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN],
    ]);
    expect(rateLimiter.recordFailureAndDelay).not.toHaveBeenCalled();
    expect(rateLimiter.reset).toHaveBeenCalledWith("127.0.0.1", AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    expect(rateLimiter.reset).not.toHaveBeenCalledWith(
      "127.0.0.1",
      AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    );
  });
});

it("rejects unattributable proxy ingress before bootstrap device-token fallback", async () => {
  const rateLimiter = createGatewayAuthRateLimiter(
    { maxAttempts: 2, windowMs: 60_000, lockoutMs: 60_000, pruneIntervalMs: 0 },
    { scheduler: createTestGatewayScheduler() },
  );

  try {
    await withPairedOperatorDeviceToken(async (operatorToken) => {
      const sendBootstrap = async (token: string) =>
        await runBootstrapConfigRequest({
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

it("serves configured avatar metadata without waiting for workspace identity", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore<identityFiles.AgentIdentityFile | null>();
  const read = vi
    .spyOn(identityFiles, "loadAgentIdentityFromWorkspaceAsync")
    .mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
  const avatar = "https://example.com/avatar.png";
  const pending = runAvatarRequest({
    url: "/avatar/main?meta=1",
    config: createAvatarConfig("/tmp/avatar-workspace", avatar),
    auth: tokenAuth,
    headers: { authorization: "Bearer test-token" },
  });
  try {
    const winner = await Promise.race([
      pending.then(() => "response" as const),
      entered.promise.then(() => "workspace-read" as const),
    ]);
    expect(winner).toBe("response");
    const response = await pending;
    expectStatus(response);
    expect(responseJson(response.end)).toEqual({
      avatarUrl: avatar,
      avatarSource: "remote URL",
      avatarStatus: "remote",
      avatarReason: null,
    });
  } finally {
    release.resolve(null);
    await pending;
    read.mockRestore();
  }
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
  expectStatus(head);
  const headers = { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" };
  expect(head.headers).toMatchObject({ ...headers, "Content-Length": String(body.byteLength) });
  expect(head.end).toHaveBeenCalledWith();
  const get = await runAvatarRequest(params);
  expect(get.res.statusCode).toBe(200);
  expect(get.end).toHaveBeenCalledWith(body);
  expect(get.headers).toMatchObject(headers);
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

  expectStatus(response, 401);
  expect(response.setHeader).not.toHaveBeenCalledWith("Content-Length", expect.anything());
});

it("rejects hardlinked avatar bytes and reports matching metadata", async () => {
  const tmp = testTempDirs.make("openclaw-avatar-http-hardlink-");
  await fs.writeFile(path.join(tmp, "original.png"), REAL_PNG);
  await fs.link(path.join(tmp, "original.png"), path.join(tmp, "avatar.png"));
  const config = createAvatarConfig(tmp, "avatar.png");

  expectNotFoundResponse(await runAvatarRequest({ url: "/avatar/main", method: "GET", config }));
  const meta = await runAvatarRequest({ url: "/avatar/main?meta=1", config });
  expectStatus(meta);
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

  const reply = await runAvatarRequest({
    url: "/avatar/main",
    config: createAvatarConfig(tmp, "avatar-link.png"),
  });

  expectNotFoundResponse(reply);
});

it("redacts unsafe avatar source values from metadata", async () => {
  const reply = await runAvatarRequest({
    url: "/avatar/main?meta=1",
    config: createAvatarConfig("/tmp/workspace", "/Users/test/private/avatar.png"),
  });

  expectStatus(reply);
  expect(responseJson(reply.end)).toEqual({
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
  expectStatus(asset);
  expect(asset.text).toBe("inside-ok\n");

  const recovery = await runControlUiRequest(tmp, "/settings/plugins", {
    headers: { accept: "application/json" },
  });
  expectStatus(recovery);
  expect(recovery.text).toContain("plugin-recovery");
});

it("clamps future filesystem mtimes so validators cannot postdate the response", async () => {
  const tmp = await createControlUiRoot();
  const fontPath = await writeFile(tmp, "fonts/lora-latin.woff2", "wOF2-mock-bytes");
  const future = new Date(Date.now() + 60 * 60 * 1000);
  await fs.utimes(fontPath, future, future);

  const reply = await runControlUiRequest(tmp, "/fonts/lora-latin.woff2", {
    rootKind: "bundled",
  });

  expect(reply.res.statusCode).toBe(200);
  const lastModified = reply.headers["Last-Modified"];
  expect(typeof lastModified).toBe("string");
  const emitted = Date.parse(lastModified as string);
  // A future validator would 304 later replacements; it must never
  // postdate the response, only trail it by clock/floor slack.
  expect(emitted).toBeLessThanOrEqual(Date.now());
  expect(emitted).toBeLessThan(future.getTime());
});

it("does not expose precompressed sidecars as independent assets", async () => {
  const tmp = await createControlUiRoot();
  const filePath = await writeAssetFile(tmp, "app-AbCd1234.js", "source\n");
  await fs.writeFile(`${filePath}.br`, brotliCompressSync("source\n"));

  const reply = await runControlUiRequest(tmp, "/assets/app-AbCd1234.js.br", {
    rootKind: "bundled",
  });

  expectNotFoundResponse(reply);
});

it("returns 406 when every HTML representation is explicitly rejected", async () => {
  const reply = await runControlUiRequest(await createControlUiRoot(), "/", {
    headers: { "accept-encoding": "*;q=0" },
  });
  expect(reply.res.statusCode).toBe(406);
  expect(reply.text).toBe("Not Acceptable");
});

it("rejects malformed encoding weights and preserves negotiated HEAD byte length", async () => {
  const tmp = await createControlUiRoot();
  const source = "console.log('static asset metadata');\n".repeat(12);
  const filePath = await writeAssetFile(tmp, "app-HeAd1234.js", source);
  await fs.writeFile(`${filePath}.gz`, gzipSync(source));
  await fs.writeFile(`${filePath}.br`, brotliCompressSync(source));
  const request = {
    rootKind: "bundled" as const,
    headers: { "accept-encoding": "br;q=0.8junk, gzip;q=0.5, identity;q=0" },
  };
  const get = await runControlUiRequest(tmp, "/assets/app-HeAd1234.js", {
    ...request,
    method: "GET",
  });
  const head = await runControlUiRequest(tmp, "/assets/app-HeAd1234.js", {
    ...request,
    method: "HEAD",
  });
  const body = get.body;

  expect(Buffer.isBuffer(body)).toBe(true);
  expect(gunzipSync(body).toString()).toBe(source);
  expect(get.headers).toMatchObject({
    "Cache-Control": "public, max-age=31536000, immutable",
    Vary: "Accept-Encoding",
  });
  expect(head.headers).toMatchObject({
    "Content-Length": String(body.byteLength),
    "Content-Encoding": "gzip",
  });
  expect(head.end.mock.calls[0]?.length ?? -1).toBe(0);
});

it("serves an asset-like Unicode approval ID through the standalone document", async () => {
  const basePath = "/openclaw";
  const url =
    "/openclaw/approve/Approval%3AMobile%2F%E6%9D%B1%E4%BA%AC%20100%25%20%F0%9F%A6%9E.json";
  const tmp = await createControlUiRoot("<html><body>standalone-spa</body></html>\n");

  for (const method of ["GET", "HEAD"] as const) {
    const reply = await runControlUiRequest(tmp, url, { method, basePath });

    expectStatus(reply);
    if (method === "HEAD") {
      expect(reply.end.mock.calls[0]?.length ?? -1).toBe(0);
    } else {
      expect(reply.text).toContain("standalone-spa");
      expect(reply.text).toContain('data-openclaw-control-ui-base-path="/openclaw"');
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

  const reply = await runControlUiRequest(tmp, "/app/route");
  expectNotFoundResponse(reply);
});

it("serves public root assets under the internal namespace", async () => {
  const tmp = await createControlUiRoot();
  await fs.writeFile(path.join(tmp, "favicon.svg"), "<svg/>");
  const reply = await runControlUiRequest(tmp, "/__openclaw__/favicon.svg");
  expectStatus(reply);
  expect(reply.headers).toMatchObject({ "Content-Type": "image/svg+xml" });
  expect(reply.text).toBe("<svg/>");
});

it.each(["absolute", "symlink"])("rejects %s escapes under basePath routes", async (kind) => {
  const { root, secretPath } = await createBasePathRootFixture();
  let route: string;
  if (kind === "symlink") {
    await fs.mkdir(path.join(root, "assets"));
    await fs.symlink(secretPath, path.join(root, "assets", "leak.txt"), "file");
    route = "/openclaw/assets/leak.txt";
  } else {
    const secretUrl = secretPath.split(path.sep).join("/");
    route = `/openclaw/${secretUrl.startsWith("/") ? secretUrl : `/${secretUrl}`}`;
  }
  expectNotFoundResponse(await runControlUiRequest(root, route, { basePath: "/openclaw" }));
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
