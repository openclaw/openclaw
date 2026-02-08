import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "./__tests__/test-utils.js";

const mockConfig = vi.hoisted(() => ({
  cfg: {
    gateway: {},
    approvals: { hitl: { enabled: false } },
  } as unknown,
}));

const mockHitl = vi.hoisted(() => ({
  createHitlRequest: vi.fn(async () => ({ ok: true, requestId: "r1", raw: {} })),
  allowlist: {
    loadHitlAllowlist: vi.fn(() => ({ version: 1, entries: [] })),
    matchesHitlAllowlist: vi.fn(() => false),
    addHitlAllowlistEntry: vi.fn(),
  },
  manager: {
    create: vi.fn((params: unknown) => {
      type HitlCreateParams = {
        kind: "outbound" | "plugin-http";
        timeoutMs: number;
        defaultDecision: "allow-once" | "allow-always" | "deny";
        summary: Record<string, unknown>;
      };
      const p = params as HitlCreateParams;
      return {
        id: "a1",
        kind: p.kind,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + p.timeoutMs,
        defaultDecision: p.defaultDecision,
        summary: p.summary,
      };
    }),
    waitForDecision: vi.fn(async () => "allow-once"),
    attachHitlRequestId: vi.fn(() => true),
  },
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return { ...actual, loadConfig: () => mockConfig.cfg };
});

vi.mock("../../infra/hitl/client.js", () => ({
  createHitlRequest: mockHitl.createHitlRequest,
}));

vi.mock("../../infra/hitl/allowlist.js", () => ({
  loadHitlAllowlist: mockHitl.allowlist.loadHitlAllowlist,
  matchesHitlAllowlist: mockHitl.allowlist.matchesHitlAllowlist,
  addHitlAllowlistEntry: mockHitl.allowlist.addHitlAllowlistEntry,
}));

vi.mock("../../infra/hitl/state.js", () => ({
  hitlApprovalManager: mockHitl.manager,
}));

const { createGatewayPluginRequestHandler } = await import("./plugins-http.js");

const makeResponse = (): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} => {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
};

describe("createGatewayPluginRequestHandler", () => {
  it("returns false when no handlers are registered", async () => {
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry(),
      log,
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });
    const { res } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(false);
  });

  it("continues until a handler reports it handled the request", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          { pluginId: "first", handler: first, source: "first" },
          { pluginId: "second", handler: second, source: "second" },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });

    const { res } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("handles registered http routes before generic handlers", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const fallback = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "route",
            path: "/demo",
            handler: routeHandler,
            source: "route",
          },
        ],
        httpHandlers: [{ pluginId: "fallback", handler: fallback, source: "fallback" }],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });

    const { res } = makeResponse();
    const handled = await handler(
      {
        url: "/demo",
        method: "GET",
        headers: { authorization: "Bearer tok", host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("requires gateway auth for non-public routes by default", async () => {
    const routeHandler = vi.fn();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [{ pluginId: "route", path: "/demo", handler: routeHandler, source: "route" }],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });
    const { res, end } = makeResponse();
    const handled = await handler(
      {
        url: "/demo",
        method: "GET",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(end).toHaveBeenCalled();
    expect(routeHandler).not.toHaveBeenCalled();
  });

  it("allows public routes without gateway auth", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 204;
      res.end();
    });
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "route",
            path: "/demo",
            handler: routeHandler,
            public: true,
            source: "route",
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });
    const { res } = makeResponse();
    const handled = await handler(
      {
        url: "/demo",
        method: "GET",
        headers: { host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(204);
  });

  it("gates routes that opt into HITL approval", async () => {
    mockConfig.cfg = {
      gateway: {},
      approvals: {
        hitl: {
          enabled: true,
          apiKey: "k",
          loopId: "l",
          callbackUrl: "https://example.com/hitl/callback/secret",
          pluginHttp: { mode: "always" },
          defaultDecision: "deny",
          timeoutSeconds: 60,
        },
      },
    } as unknown;
    mockHitl.manager.waitForDecision.mockResolvedValueOnce("deny");
    const routeHandler = vi.fn();
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "route",
            path: "/demo",
            handler: routeHandler,
            requireHitlApproval: true,
            source: "route",
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });
    const { res } = makeResponse();
    const handled = await handler(
      {
        url: "/demo",
        method: "POST",
        headers: { authorization: "Bearer tok", host: "localhost" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      res,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(routeHandler).not.toHaveBeenCalled();
  });

  it("logs and responds with 500 when a handler throws", async () => {
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          {
            pluginId: "boom",
            handler: async () => {
              throw new Error("boom");
            },
            source: "boom",
          },
        ],
      }),
      log,
      auth: { mode: "token", token: "tok", allowTailscale: false },
    });

    const { res, setHeader, end } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });
});
