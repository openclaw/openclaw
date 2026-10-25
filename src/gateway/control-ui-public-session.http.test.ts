import fs from "node:fs";
import type { Server } from "node:http";
import nodePath from "node:path";
import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  AUTH_TOKEN,
  createResponse,
  createTestGatewayServer,
  sendRequest,
} from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const reader = vi.hoisted(() => vi.fn());
const shareActive = vi.hoisted(() => vi.fn());
const tokenResolver = vi.hoisted(() => vi.fn());
const widgetToken = vi.hoisted(() => vi.fn());
const renderCard = vi.hoisted(() => vi.fn());
vi.mock(import("./control-ui-public-session-card.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  createPublicSessionCardRenderer: () => ({ render: renderCard, dispose: async () => {} }),
}));
// mock-isolation: Keep persisted session state outside this HTTP transport fixture.
vi.mock("./control-ui-public-session-read.js", () => ({
  isPublicSessionShareActive: shareActive,
  readPublicSessionShare: reader,
}));
// mock-isolation: The transport fixture supplies exact token outcomes without installation identity.
vi.mock("./control-ui-public-session-token.js", () => ({
  resolvePublicSessionShareToken: tokenResolver,
  mintPublicSessionWidgetToken: widgetToken,
}));

const TEST_CONFIG: OpenClawConfig = {
  gateway: { publicOrigin: "https://gateway.example.test" },
};
const PROXY_CONFIG: OpenClawConfig = {
  gateway: { ...TEST_CONFIG.gateway, trustedProxies: ["10.0.0.1"] },
};
const LOCATOR = {
  agentId: "demo",
  sessionKey: "agent:demo:topic:with space",
  sessionId: "séssion.123",
  shareId: "a".repeat(48),
};
const PUBLIC_SESSION = {
  title: "Launch notes",
  messages: [
    { role: "user" as const, content: "What changed?" },
    { role: "assistant" as const, content: "The public viewer is ready." },
  ],
  totalMessages: 2,
  truncated: false,
};

const servers = new Set<Server>();
const dirs = useAutoCleanupTempDirTracker(afterEach);
function createPublicGateway(basePath = "", config: OpenClawConfig = TEST_CONFIG): Server {
  const context = createGatewayRequestContext(makeContextParams());
  context.resolveGatewayContext = () => context;
  const projection = createSessionRowProjectionFixture({ cfg: config, store: {} });
  bindSessionRowProjection(context, () => projection);
  const root = dirs.make("session-card-http-");
  fs.writeFileSync(nodePath.join(root, "social-card.png"), "static card bytes");
  const server = createTestGatewayServer({
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      controlUiEnabled: true,
      controlUiBasePath: basePath,
      controlUiRoot: { kind: "resolved", path: root },
      getRuntimeConfig: () => config,
      getGatewayRequestContext: () => context,
      httpRequestLifetime: context,
    },
  });
  servers.add(server);
  return server;
}

function requestPath(basePath = ""): string {
  return buildControlUiPublicSessionSharePath({ token: `v1.${LOCATOR.shareId}AA`, basePath });
}
function cardPath(basePath = "") {
  return requestPath(basePath).replace("/share/session?", "/share/session/card.png?");
}
const invalidPath = buildControlUiPublicSessionSharePath({ token: `v1.${"z".repeat(96)}` });
function send(server: Server, params: Partial<Parameters<typeof sendRequest>[1]> = {}) {
  return sendRequest(server, {
    ...params,
    path: params.path ?? requestPath(),
    remoteAddress: params.remoteAddress ?? "127.0.0.1",
    host: "127.0.0.1:18789",
  });
}
function fromProxy(server: Server, clientIp: string, path?: string, proto = "https") {
  return send(server, {
    ...(path ? { path } : {}),
    remoteAddress: "10.0.0.1",
    headers: { "x-forwarded-for": clientIp, "x-forwarded-proto": proto },
  });
}
function expectStatic(response: ReturnType<typeof createResponse>) {
  expect(response.end).toHaveBeenLastCalledWith(Buffer.from("static card bytes"));
}
function expectText(text: string | undefined, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}
function expectAbsent(text: string | undefined, ...parts: string[]) {
  for (const part of parts) {
    expect(text).not.toContain(part);
  }
}
async function readPage(server: Server, params: Parameters<typeof send>[1] = {}) {
  const response = await send(server, params);
  expect(response.res.statusCode).toBe(200);
  return response.getBody();
}
function expectLimited(response: ReturnType<typeof createResponse>) {
  expect(response.res.statusCode).toBe(429);
  expect(Number(responseHeader(response, "Retry-After"))).toBeGreaterThan(0);
}

function responseHeader(
  response: ReturnType<typeof createResponse>,
  name: string,
): string | undefined {
  const call = response.setHeader.mock.calls.findLast(
    ([headerName]) => String(headerName).toLowerCase() === name.toLowerCase(),
  );
  return call ? String(call[1]) : undefined;
}

beforeEach(() => {
  resetGatewayWorkAdmission();
  reader.mockReset().mockResolvedValue(PUBLIC_SESSION);
  renderCard.mockReset().mockResolvedValue(Buffer.from("rendered card bytes"));
  shareActive.mockReset().mockReturnValue(true);
  tokenResolver.mockReset().mockImplementation((token: string) => {
    const shareId = token.slice(3, 51);
    return /^[a-f0-9]{48}$/u.test(shareId) ? { ...LOCATOR, shareId } : null;
  });
  widgetToken.mockReset().mockResolvedValue("v1.document-only");
});

afterEach(() => {
  for (const server of servers) {
    server.emit("close");
  }
  servers.clear();
  resetGatewayWorkAdmission();
});

describe("anonymous public session HTTP boundary", () => {
  it("mints a document-scoped widget link under the configured base path", async () => {
    reader.mockResolvedValue({
      ...PUBLIC_SESSION,
      messages: [{ role: "assistant", content: '[embed ref="chart" /]' }],
    });
    const html = await readPage(createPublicGateway("/control"), { path: requestPath("/control") });
    expect(widgetToken).toHaveBeenCalledWith(LOCATOR, "chart");
    expect(html).toContain('src="/control/share/session/media?widget=v1.document-only"');
  });
  it("keeps the page available but omits frames for disabled hosting or unmintable references", async () => {
    reader.mockResolvedValue({
      ...PUBLIC_SESSION,
      messages: [{ role: "assistant", content: 'Chart below.\n\n[embed ref="chart" /]' }],
    });
    const disabled = await readPage(
      createPublicGateway("", {
        ...TEST_CONFIG,
        plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
      }),
    );
    expect(disabled).toContain("Chart below.");
    expectAbsent(disabled, "<iframe");
    expect(widgetToken).not.toHaveBeenCalled();
    widgetToken.mockResolvedValue(undefined);
    expectAbsent(await readPage(createPublicGateway()), "<iframe");
  });
  it.each(["", "/control"])(
    "serves only published text and keeps private APIs authenticated (%s)",
    async (basePath) => {
      const server = createPublicGateway(basePath);
      const route = requestPath(basePath);
      const response = await send(server, { path: route });
      expect(response.res.statusCode).toBe(200);
      const html = response.getBody();
      expectText(
        html,
        "The public viewer is ready.",
        `${basePath}/share/session/card.png?token=`,
        'property="og:image:width" content="1200"',
        'property="og:image:height" content="630"',
        'name="twitter:image:alt" content="Launch notes · OpenClaw public session"',
      );
      expect(html).not.toMatch(/agent:demo|séssion\.123|new WebSocket|openclaw-app/);
      expect(responseHeader(response, "Cache-Control")).toBe("no-store");
      expect(responseHeader(response, "Referrer-Policy")).toBe("no-referrer");
      const csp = responseHeader(response, "Content-Security-Policy");
      expectText(csp, "default-src 'none'", "font-src 'self'", ...computeInlineScriptHashes(html));

      reader.mockClear();
      const head = await send(server, { path: route, method: "HEAD" });
      expect(head.res.statusCode).toBe(405);
      expect(responseHeader(head, "Allow")).toBe("GET");
      expect(responseHeader(head, "Content-Length")).toBe("0");
      expect(head.getBody()).toBe("");
      expect(reader).not.toHaveBeenCalled();

      const privateApi = await send(server, {
        path: `${basePath}/__openclaw__/assistant-media?source=missing.png`,
      });
      expect(privateApi.res.statusCode).toBe(401);
      reader.mockResolvedValueOnce({
        title: "Earlier notes",
        messages: [],
        truncated: false,
        olderOffset: 200,
      });
      const older = await send(server, { path: `${route}&offset=100` });
      expect(older.res.statusCode).toBe(200);
      expect(reader).toHaveBeenLastCalledWith(expect.any(Object), LOCATOR, {
        offset: 100,
        projection: expect.any(Object),
      });
      expect(older.getBody()).toContain("&amp;offset=200");
      const before = reader.mock.calls.length;
      for (const path of [
        "/share/session/demo/session-123?key=agent%3Ademo%3Atopic&share=" + "a".repeat(48),
        `${route}&token=v1.duplicate`,
        `${route}&draft=private`,
        `${route}&offset=-1`,
        `${route}&offset=0&offset=100`,
        route.replace("token=", "unknown="),
        `${basePath}/share/session/demo/session-123`,
      ]) {
        expect((await send(server, { path })).res.statusCode).toBe(404);
      }
      expect((await send(server, { path: route, method: "POST" })).res.statusCode).toBe(404);
      expect(reader.mock.calls.length).toBe(before);
      reader.mockResolvedValue(null);
      shareActive.mockReturnValue(false);
      const revoked = await send(server, { path: route });
      expect(revoked.res.statusCode).toBe(404);
      expect(revoked.getBody()).toBe("This public session is unavailable.");
      expect(responseHeader(revoked, "Cache-Control")).toBe("no-store");
      shareActive.mockReturnValue(true);
      sessionChanges.emit({ sessionKey: LOCATOR.sessionKey });
      reader.mockRejectedValue(new Error("private store location"));
      const unavailable = await send(server, { path: route });
      expect(unavailable.res.statusCode).toBe(503);
      expect(responseHeader(unavailable, "Retry-After")).toBe("1");
      expect(unavailable.getBody()).not.toContain("private store location");
    },
  );

  it.each(["", "/control"])(
    "serves a redacted card through the public boundary (%s)",
    async (basePath) => {
      const server = createPublicGateway(basePath);
      const path = cardPath(basePath);
      reader.mockResolvedValue({
        ...PUBLIC_SESSION,
        title: "<headline>",
        messages: [
          { role: "toolResult", content: "PRIVATE_TOOL_CONTENT" },
          { role: "user", provenance: { kind: "internal" }, content: "PRIVATE_INPUT" },
          { role: "user", content: "Public opening" },
        ],
      });
      const first = await send(server, { path });
      expect(first.end).toHaveBeenLastCalledWith(Buffer.from("rendered card bytes"));
      expect(renderCard).toHaveBeenCalledWith(
        expect.objectContaining({ title: "<headline>", quote: "Public opening", messageCount: 2 }),
      );
      expect(JSON.stringify(renderCard.mock.calls)).not.toContain("PRIVATE_");
    },
  );

  it("returns the same static PNG for unknown, unpublished, renderer failures and insecure ingress", async () => {
    const server = createPublicGateway();
    const path = cardPath();
    tokenResolver.mockResolvedValueOnce(null);
    expectStatic(await send(server, { path }));
    reader.mockResolvedValueOnce(null);
    expectStatic(await send(server, { path }));
    renderCard.mockRejectedValueOnce(new Error("PRIVATE_RENDER_ERROR"));
    expectStatic(await send(server, { path }));
    expectStatic(await send(server, { path, remoteAddress: "203.0.113.12" }));
    expect(tokenResolver).toHaveBeenCalledTimes(3);
    expectStatic(await send(server, { path: `${path}&offset=1` }));
  });

  it("shares the page's client rate limit with card requests", async () => {
    const server = createPublicGateway();
    for (let request = 0; request < 120; request++) {
      await send(server);
    }
    const limited = await send(server, { path: cardPath() });
    expectStatic(limited);
    expect(responseHeader(limited, "Cache-Control")).toBe("no-store");
    expect(renderCard).not.toHaveBeenCalled();
  });

  it("rejects transcript work after Gateway admission closes while generic previews stay cheap", async () => {
    const server = createPublicGateway();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    try {
      const transcript = await send(server);
      expect(transcript.res.statusCode).toBe(503);
      expect(transcript.getBody()).toContain("gateway_unavailable");
      expect(reader).not.toHaveBeenCalled();

      const preview = await send(server, { path: "/share/dashboard/example/private-name" });
      expect(preview.res.statusCode).toBe(200);
      expect(preview.getBody()).toContain("OpenClaw dashboard");
      expect(reader).not.toHaveBeenCalled();
    } finally {
      suspension?.release();
    }
  });

  it("uses trusted client attribution for fixed per-client request budgets", async () => {
    const server = createPublicGateway("", PROXY_CONFIG);

    for (let request = 0; request < 120; request += 1) {
      expect((await fromProxy(server, "203.0.113.10")).res.statusCode).toBe(200);
    }
    expect((await fromProxy(server, "203.0.113.11")).res.statusCode).toBe(200);
    expectLimited(await fromProxy(server, "203.0.113.10"));
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("rate-limits malformed opaque tokens before transcript work", async () => {
    const server = createPublicGateway();
    for (let request = 0; request < 120; request += 1) {
      expect((await send(server, { path: invalidPath })).res.statusCode).toBe(404);
    }
    expectLimited(await send(server, { path: invalidPath }));
    expect(tokenResolver).toHaveBeenCalledTimes(120);
    expect(reader).not.toHaveBeenCalled();
  });

  it("evicts old client buckets instead of locking out every new viewer", async () => {
    const server = createPublicGateway("", PROXY_CONFIG);
    for (let request = 0; request <= 4_096; request += 1) {
      const response = await fromProxy(server, `2001:db8::${request.toString(16)}`, invalidPath);
      expect(response.res.statusCode).toBe(404);
    }
    expect(tokenResolver).toHaveBeenCalledTimes(4_097);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps bearer navigation relative without an explicit external origin", async () => {
    const html = await readPage(createPublicGateway("", {}));
    expectAbsent(html, 'rel="canonical"', 'property="og:url"');
    expect(html).toContain(`data-public-refresh-now href="${requestPath()}"`);
  });

  it.each([
    ["HTTP public origin", { gateway: { publicOrigin: "http://gateway.example.test" } }, false],
    ["HTTPS public origin", TEST_CONFIG, false],
    ["trusted proxy", PROXY_CONFIG, true],
  ] as const)("rejects plaintext bearer ingress through %s", async (_name, config, proxy) => {
    const server = createPublicGateway("", config);
    const response = proxy
      ? await fromProxy(server, "203.0.113.14", undefined, "http")
      : await send(server, { remoteAddress: "203.0.113.12" });
    expect(response.res.statusCode).toBe(404);
    expect(tokenResolver).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("caps aggregate requests to one publication across clients", async () => {
    const server = createPublicGateway("", PROXY_CONFIG);
    for (let request = 0; request < 240; request += 1) {
      const response = await fromProxy(server, `2001:db8::${request.toString(16)}`);
      expect(response.res.statusCode).toBe(200);
    }
    expectLimited(await fromProxy(server, "2001:db8::ffff"));
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "publication"] as const)(
    "serves a fresh public document when metadata changes during %s",
    async (phase) => {
      const server = createPublicGateway();
      const changed = { ...PUBLIC_SESSION, title: "Updated public title" };
      reader.mockResolvedValue(changed);
      if (phase === "read") {
        reader.mockImplementationOnce(async () => {
          sessionChanges.emit({ sessionKey: LOCATOR.sessionKey, scope: "session-entry" });
          return PUBLIC_SESSION;
        });
      } else {
        reader.mockResolvedValueOnce(PUBLIC_SESSION);
        shareActive.mockImplementationOnce(() => {
          sessionChanges.emit({ sessionKey: LOCATOR.sessionKey, scope: "session-entry" });
          return true;
        });
      }
      expect(await readPage(server)).toContain("Updated public title");
      expect(reader).toHaveBeenCalledTimes(2);
    },
  );

  it("truncates titles and messages without splitting UTF-16 surrogate pairs", async () => {
    const server = createPublicGateway();
    reader.mockResolvedValueOnce({
      title: `${"a".repeat(199)}😀 trailing`,
      messages: [{ role: "user" as const, content: `${"b".repeat(32_767)}😀 UNIQUE_TAIL_MARKER` }],
      totalMessages: 1,
      truncated: false,
    });
    const html = await readPage(server);
    expectText(
      html,
      `<title>${"a".repeat(199)} · OpenClaw</title>`,
      `property="og:title" content="${"a".repeat(199)}"`,
    );
    expect(html).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expectText(html, "Message shortened for this public view.", "b".repeat(32_767));
    expectAbsent(html, "UNIQUE_TAIL_MARKER", "😀");
  });
});
