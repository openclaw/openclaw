import fs from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reloadControlUiDocument } from "../../ui/src/app/stale-chunk-reload.ts";
import { sessionNavigationTarget } from "../../ui/src/lib/sessions/route-navigation.ts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import { AUTH_TOKEN, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
const { resolveSession, reader, active, mediaToken } = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  reader: vi.fn(),
  active: vi.fn(),
  mediaToken: vi.fn(),
}));
vi.mock(import("./control-ui-session-path-resolve.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveControlUiSessionPath: resolveSession,
}));
vi.mock(import("./control-ui-public-session-read.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  readPublicSessionShare: reader,
  isPublicSessionShareActive: active,
}));
vi.mock(import("./control-ui-public-session-token.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  mintExistingPublicSessionShareToken: mediaToken,
}));
vi.mock(import("./session-row-projection-access.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSessionRowProjection: () => projection,
}));
const key = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
let projection: ReturnType<typeof createSessionRowProjectionFixture>;
const route = "/control/chat/main/launch-12345678aaaa40008000000000000001";
const servers: Server[] = [];
const dirs = useAutoCleanupTempDirTracker(afterEach);
function server(mode: "token" | "password" = "token") {
  const cfg = { gateway: { publicOrigin: "https://example.test", trustedProxies: ["127.0.0.1"] } };
  setRuntimeConfigSnapshot(cfg);
  const root = dirs.make("chat-deeplink-");
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<html><head></head><body><openclaw-app></openclaw-app></body></html>",
  );
  const created = createTestGatewayServer({
    resolvedAuth: { ...AUTH_TOKEN, mode, password: "test-password" },
    overrides: {
      controlUiEnabled: true,
      controlUiBasePath: "/control",
      controlUiRoot: { kind: "resolved", path: root },
      getRuntimeConfig: () => cfg,
    },
  });
  servers.push(created);
  return created;
}
function request(
  instance: Server,
  requestPath = route,
  headers?: Record<string, string>,
  method?: string,
) {
  return sendRequest(instance, {
    path: requestPath,
    headers,
    method,
    host: "localhost",
    remoteAddress: "127.0.0.1",
  });
}
type Response = Awaited<ReturnType<typeof request>>;
function page(response: Response, status: number, ...contents: string[]) {
  expect(response.res.statusCode).toBe(status);
  for (const content of contents) {
    expect(response.getBody()).toContain(content);
  }
  return response.getBody();
}
function lanRequest(instance: Server, requestPath: string) {
  return sendRequest(instance, {
    path: requestPath,
    host: "gateway.lan:18789",
    remoteAddress: "192.168.1.25",
  });
}
async function handoff(instance: Server, requestPath: string) {
  const entry = `/control/__openclaw__/session-entry?path=${encodeURIComponent(requestPath)}`;
  page(await request(instance, `${entry}&probe=1`), 401);
  return page(await request(instance, entry), 200, "<openclaw-app>");
}
beforeEach(() => {
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  projection = createSessionRowProjectionFixture({
    cfg: { agents: { entries: { main: {} } } },
    store: {
      [key]: {
        sessionId: "generation",
        updatedAt: 1,
        publicShare: { id: "a".repeat(48), sessionId: "generation", createdAt: 1 },
      },
    },
  });

  resolveSession.mockReset().mockResolvedValue({ key, agentId: "main" });
  reader.mockReset().mockResolvedValue({
    title: "Public launch notes",
    messages: [{ role: "assistant", content: "Published answer" }],
    truncated: false,
  });
  active.mockReset().mockReturnValue(true);
  mediaToken.mockReset().mockResolvedValue(`v1.${"a".repeat(96)}`);
});
afterEach(() => {
  for (const instance of servers.splice(0)) {
    instance.emit("close");
  }
  projection.dispose();
  clearRuntimeConfigSnapshot();
});

describe("canonical anonymous HTTP entry", () => {
  it("keeps published text available when no token identity is present", async () => {
    mediaToken.mockResolvedValue(undefined);
    page(await request(server()), 200, "Published answer");
  });

  it("reloads the exact Incognito address produced by in-app navigation", async () => {
    const sessionKey = "agent:main:dashboard:incognito-12345678-aaaa-4000-8000-000000000001";
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey,
      navigationKey: sessionKey,
      fallbackAgentId: "main",
      basePath: "/control",
    });
    page(
      await lanRequest(server(), target.options.pathname + (target.options.search ?? "")),
      200,
      "<openclaw-app>",
    );
    expect(resolveSession).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("reloads a chat through the exact recovery URL without exposing its private transcript", async () => {
    const replace = vi.fn();
    const url = new URL(`${route}?draft=Follow+up&dashboard=expanded`, "http://localhost");
    vi.stubGlobal("window", { location: { replace } });
    try {
      reloadControlUiDocument(url);
    } finally {
      vi.unstubAllGlobals();
    }
    const recoveryUrl = new URL(replace.mock.calls[0]![0]);
    const recoveryPath = recoveryUrl.pathname + recoveryUrl.search;
    resolveSession.mockResolvedValue(null);
    const instance = server();
    const privateChat = await request(instance, recoveryPath);
    expect(page(privateChat, 404, 'data-gateway-path="/control"')).not.toContain(
      "Published answer",
    );
    expect(await handoff(instance, recoveryPath)).toContain(JSON.stringify(recoveryPath));
    page(await lanRequest(instance, recoveryPath), 200, "<openclaw-app>");
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "token", secureProxy: false },
    { mode: "password", secureProxy: false },
    { mode: "token", secureProxy: true },
    { mode: "password", secureProxy: true },
  ] as const)(
    "offers a $mode browser-credential handoff (secureProxy=$secureProxy)",
    async ({ mode, secureProxy }) => {
      resolveSession.mockResolvedValue(null);
      const instance = server(mode);
      const response = await sendRequest(instance, {
        path: route,
        host: secureProxy ? "example.test" : "localhost",
        remoteAddress: "127.0.0.1",
        headers: secureProxy
          ? { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.42" }
          : {},
      });
      expect(page(response, 404, 'data-gateway-path="/control"')).not.toContain("<openclaw-app>");
      expect(await handoff(instance, route)).toContain(
        `history.replaceState(null,"","${route}"+location.hash)`,
      );
    },
  );

  it("retains an existing dashboard presentation link without mixing cached login destinations", async () => {
    const instance = server();
    expect(page(await request(instance), 200)).not.toContain("%3Fdashboard%3Dexpanded");
    page(await request(instance, `${route}?dashboard=expanded`), 200, "%3Fdashboard%3Dexpanded");
    expect(reader).toHaveBeenCalledTimes(2);
    expect(
      page(
        await request(instance, `${route}?draft=Follow+up&offset=0`),
        200,
        "%3Fdraft%3DFollow%2Bup",
      ),
    ).not.toContain("offset%3D");
  });

  it("serves a bounded reader, ignores forged identity, and probes only the protected entry", async () => {
    const response = await request(server(), route, {
      "cf-access-authenticated-user-email": "forged@example.test",
      "x-openclaw-scopes": "operator.admin",
    });
    const html = page(
      response,
      200,
      "Published answer",
      `https://example.test/control/share/session/card.png?token=v1.${"a".repeat(96)}`,
      'name="twitter:image:alt" content="Public launch notes · OpenClaw public session"',
      "/__openclaw__/session-entry?path=%2Fcontrol%2Fchat%2Fmain%2Flaunch-",
    );
    expect(html).not.toMatch(/openclaw-app|new WebSocket|sessions.list|bootstrap-config/);
    expect(resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({ client: null, publicOnly: true }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("script-src 'sha256-"),
    );
    const csp = response.setHeader.mock.calls.find(
      ([name]) => name === "Content-Security-Policy",
    )?.[1];
    for (const hash of computeInlineScriptHashes(html)) {
      expect(csp).toContain(hash);
    }
  });
  it("makes private, missing, and revoked sessions indistinguishable but keeps Log in", async () => {
    resolveSession.mockResolvedValue(null);
    const instance = server();
    const hidden = await request(instance);
    const missing = await request(instance);
    resolveSession.mockResolvedValue({ key, agentId: "main" });
    active.mockReturnValue(false);
    const revoked = await request(instance);
    const html = page(hidden, 404, "Log in");
    expect([missing.getBody(), revoked.getBody()]).toEqual([html, html]);
    expect(html).not.toContain("Public launch notes");
  });
  it("revalidates publication before conditional reuse", async () => {
    const instance = server();
    const first = await request(instance);
    const etag = first.setHeader.mock.calls.find(([name]) => name === "ETag")?.[1];
    expect(typeof etag).toBe("string");
    const unchanged = await request(instance, route, { "if-none-match": String(etag) });
    expect(unchanged.res.statusCode).toBe(304);
    expect(reader).toHaveBeenCalledTimes(1);
    active.mockReturnValue(false);
    expect((await request(instance, route, { "if-none-match": String(etag) })).res.statusCode).toBe(
      404,
    );
  });
  it("rejects HEAD and malformed query work before reading any session", async () => {
    const instance = server();
    expect((await request(instance, route, undefined, "HEAD")).res.statusCode).toBe(405);
    for (const suffix of ["?offset=-1", "?offset=0&offset=1", "?token=ignored", "?probe=1"]) {
      expect((await request(instance, route + suffix)).res.statusCode).toBe(404);
    }
    expect(resolveSession).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });
});
