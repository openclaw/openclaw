import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_TOKEN, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
const { resolveSession, reader, active } = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  reader: vi.fn(),
  active: vi.fn(),
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
vi.mock(import("./session-row-projection-access.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSessionRowProjection: () => projection,
}));
const key = "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001";
const projection = createSessionRowProjectionFixture({
  cfg: { agents: { entries: { main: {} } } },
  store: {
    [key]: {
      sessionId: "generation",
      updatedAt: 1,
      publicShare: { id: "a".repeat(48), sessionId: "generation", createdAt: 1 },
    },
  },
});
const route = "/control/chat/main/launch-12345678aaaa40008000000000000001";
const servers: Server[] = [];
function server() {
  const cfg = { gateway: { publicOrigin: "https://example.test" } };
  const created = createTestGatewayServer({
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      controlUiEnabled: true,
      controlUiBasePath: "/control",
      getRuntimeConfig: () => cfg,
    },
  });
  servers.push(created);
  return created;
}
function request(
  instance: Server,
  path = route,
  headers?: Record<string, string>,
  method?: string,
) {
  return sendRequest(instance, {
    path,
    headers,
    method,
    host: "localhost",
    remoteAddress: "127.0.0.1",
  });
}
beforeEach(() => {
  resolveSession.mockReset().mockResolvedValue({ key, agentId: "main" });
  reader.mockReset().mockResolvedValue({
    title: "Public launch notes",
    messages: [{ role: "assistant", content: "Published answer" }],
    truncated: false,
  });
  active.mockReset().mockReturnValue(true);
});
afterEach(() => {
  for (const instance of servers.splice(0)) {
    instance.emit("close");
  }
});

describe("canonical anonymous HTTP entry", () => {
  it("preserves a private login handoff on direct HTTP without reading a transcript", async () => {
    const response = await sendRequest(server(), {
      path: route,
      host: "gateway.lan:18789",
      remoteAddress: "192.168.1.25",
      authorization: "Bearer test-token",
    });
    expect(response.res.statusCode).toBe(404);
    expect(response.getBody()).toContain("Log in");
    expect(response.getBody()).not.toContain("Published answer");
    expect(resolveSession).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it("retains an existing dashboard presentation link without mixing cached login destinations", async () => {
    const instance = server();
    const ordinary = await request(instance);
    expect(ordinary.res.statusCode).toBe(200);
    expect(ordinary.getBody()).not.toContain("%3Fdashboard%3Dexpanded");
    const dashboard = await request(instance, `${route}?dashboard=expanded`);
    expect(dashboard.res.statusCode).toBe(200);
    expect(dashboard.getBody()).toContain("%3Fdashboard%3Dexpanded");
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("serves a bounded reader, ignores forged identity, and probes only the protected entry", async () => {
    const response = await request(server(), route, {
      "cf-access-authenticated-user-email": "forged@example.test",
      "x-openclaw-scopes": "operator.admin",
    });
    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Published answer");
    expect(response.getBody()).toContain(
      "/__openclaw__/session-entry?path=%2Fcontrol%2Fchat%2Fmain%2Flaunch-",
    );
    expect(response.getBody()).not.toMatch(
      /openclaw-app|new WebSocket|sessions.list|bootstrap-config/,
    );
    expect(resolveSession).toHaveBeenCalledWith(
      expect.objectContaining({ client: null, publicOnly: true }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Security-Policy",
      expect.stringContaining("script-src 'sha256-"),
    );
  });
  it("makes private, missing, and revoked sessions indistinguishable but keeps Log in", async () => {
    resolveSession.mockResolvedValue(null);
    const instance = server();
    const hidden = await request(instance);
    const missing = await request(instance);
    resolveSession.mockResolvedValue({ key, agentId: "main" });
    active.mockReturnValue(false);
    const revoked = await request(instance);
    expect(hidden.res.statusCode).toBe(404);
    expect(hidden.getBody()).toBe(missing.getBody());
    expect(hidden.getBody()).toBe(revoked.getBody());
    expect(hidden.getBody()).toContain("Log in");
    expect(hidden.getBody()).not.toContain("Public launch notes");
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
