import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// Hook HTTP delivery tests prove target binding before detached work is accepted.
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { HookMappingResolved } from "./hooks-mapping.js";
import { createHooksConfig } from "./hooks-test-helpers.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "./hooks.js";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";
import { createHooksRequestHandler } from "./server/hooks-request-handler.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));
const emptyRegistry = createTestRegistry([]);
const deliveryRegistry = createTestRegistry([
  {
    pluginId: "delivery-test",
    source: "test",
    plugin: createChannelTestPluginBase({
      id: "delivery-test",
      label: "Delivery Test",
      docsPath: "/channels/delivery-test",
    }),
  },
]);

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function createDeliveryHandler(params?: {
  mappings?: HookMappingResolved[];
  agentPolicy?: Partial<HooksConfigResolved["agentPolicy"]>;
}) {
  const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
  const dispatchAgentHook = vi.fn((_value: HookAgentDispatchPayload) => ({
    ok: true as const,
    runId: "run-1",
    completion: Promise.resolve({ status: "ok" as const, replyDisposition: "empty" as const }),
  }));
  const canonicalConfig = createHooksConfig();
  const hooksConfig = {
    ...canonicalConfig,
    mappings: params?.mappings ?? [],
    agentPolicy: { ...canonicalConfig.agentPolicy, ...params?.agentPolicy },
  };
  const handler = createHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    getHooksConfig: () => hooksConfig,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as ReturnType<typeof createSubsystemLogger>,
    dispatchWakeHook,
    dispatchAgentHook,
  });
  return { handler, dispatchAgentHook, dispatchWakeHook };
}

async function dispatchPayload(params: {
  handler: ReturnType<typeof createHooksRequestHandler>;
  path: string;
  payload: Record<string, unknown>;
}) {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: params.payload });
  const req = createHookRequest({ url: params.path });
  const response = createResponse();
  await params.handler(req, response.res);
  return response;
}

describe("hook request delivery normalization", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
    setActivePluginRegistry(deliveryRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  test("binds direct delivery only to a concrete channel and recipient", async () => {
    const { handler, dispatchAgentHook } = createDeliveryHandler();

    const omitted = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "No coordinates" },
    });
    expect(omitted.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });

    const recipientOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Recipient only", to: "sensitive-recipient" },
    });
    expect(recipientOnly.res.statusCode).toBe(400);
    expect(recipientOnly.getBody()).toContain("channel and to must be set together");

    const malformedRecipient = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Malformed recipient", to: 123 },
    });
    expect(malformedRecipient.res.statusCode).toBe(400);
    expect(malformedRecipient.getBody()).toContain("to must be a non-empty string");

    const channelOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Channel only", channel: "delivery-test" },
    });
    expect(channelOnly.res.statusCode).toBe(400);
    expect(channelOnly.getBody()).toContain("channel and to must be set together");
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);

    const optedOutChannelOnly = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: {
        message: "Opted out channel only",
        deliver: false,
        channel: "stale-channel",
        to: "sensitive-recipient",
      },
    });
    expect(optedOutChannelOnly.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      deliver: false,
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });

    const explicit = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: {
        message: "Explicit",
        channel: "delivery-test",
        to: "123456",
        accountId: "work",
      },
    });
    expect(explicit.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[2]?.[0]).toMatchObject({
      accountId: "work",
      delivery: {
        mode: "announce",
        channel: "delivery-test",
        to: "123456",
        accountId: "work",
      },
    });
  });

  test("preserves mapped delivery semantics while binding the CronJob target", async () => {
    const mapped = createDeliveryHandler({
      mappings: [
        {
          id: "channel-only",
          matchPath: "channel-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          channel: "delivery-test",
        },
        {
          id: "recipient-only",
          matchPath: "recipient-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          to: "123456",
        },
      ],
    });

    const channelOnly = await dispatchPayload({
      handler: mapped.handler,
      path: "/hooks/channel-only",
      payload: {},
    });
    const recipientOnly = await dispatchPayload({
      handler: mapped.handler,
      path: "/hooks/recipient-only",
      payload: {},
    });

    expect(channelOnly.res.statusCode).toBe(200);
    expect(recipientOnly.res.statusCode).toBe(200);
    expect(mapped.dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "delivery-test", to: undefined },
    });
    expect(mapped.dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "last", to: "123456" },
    });

    const optedOut = createDeliveryHandler({
      mappings: [
        {
          id: "channel-only",
          matchPath: "channel-only",
          action: "agent",
          wakeMode: "now",
          messageTemplate: "Mapped",
          deliver: false,
          channel: "delivery-test",
        },
      ],
    });
    const optedOutResponse = await dispatchPayload({
      handler: optedOut.handler,
      path: "/hooks/channel-only",
      payload: {},
    });

    expect(optedOutResponse.res.statusCode).toBe(200);
    expect(optedOut.dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      deliver: false,
      channel: "delivery-test",
      delivery: { mode: "none" },
    });
  });

  test.each([
    ["/hooks/agent", { message: "Direct", agentId: "  " }],
    ["/hooks/wake", { text: "Wake", agentId: "  " }],
  ])("rejects a blank direct agentId on %s without dispatch", async (path, payload) => {
    const { handler, dispatchAgentHook, dispatchWakeHook } = createDeliveryHandler();

    const response = await dispatchPayload({ handler, path, payload });

    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain("agentId must be a non-empty string");
    expect(dispatchAgentHook).not.toHaveBeenCalled();
    expect(dispatchWakeHook).not.toHaveBeenCalled();
  });

  test("preserves config-mapping fallback for an unrepresentable agentId", async () => {
    const { handler, dispatchAgentHook } = createDeliveryHandler({
      mappings: [
        {
          id: "mapped-unknown-agent",
          matchPath: "mapped-unknown-agent",
          action: "agent",
          agentId: "!!!",
          messageTemplate: "Mapped fallback",
        },
      ],
    });

    const mapping = await dispatchPayload({
      handler,
      path: "/hooks/mapped-unknown-agent",
      payload: {},
    });
    expect(mapping.res.statusCode).toBe(200);
    expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      effectiveAgentId: "main",
    });
  });

  test.each([
    {
      owner: { kind: "configured" as const, agentId: "ops" },
      error: 'agentId \\"research\\" conflicts with global session-store owner \\"ops\\"',
    },
    {
      owner: { kind: "retired" as const, agentId: "retired" },
      error: 'global session-store owner \\"retired\\" is no longer configured',
    },
  ])("reports $owner.kind global session-store ownership", async ({ owner, error }) => {
    const { handler, dispatchAgentHook } = createDeliveryHandler({
      agentPolicy: {
        globalSessionStoreOwner: owner,
        knownAgentIds: new Set(["ops", "research"]),
      },
    });

    const response = await dispatchPayload({
      handler,
      path: "/hooks/agent",
      payload: { message: "Direct", agentId: "research" },
    });
    expect(response.res.statusCode).toBe(400);
    expect(response.getBody()).toContain(error);
    expect(response.getBody()).not.toContain("agentId is required");
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });
});

function expectRetryAfterHeader(setHeader: ReturnType<typeof vi.fn>): void {
  const retryAfterCall = setHeader.mock.calls.find(([name]) => name === "Retry-After");
  if (!retryAfterCall) {
    throw new Error("Expected Retry-After header call");
  }
  const retryAfterValue = retryAfterCall[1];
  expect(typeof retryAfterValue).toBe("string");
  expect(Number.parseInt(String(retryAfterValue), 10)).toBeGreaterThan(0);
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
    const dispatchAgentHook = vi.fn(() => ({
      ok: true as const,
      runId: "run-1",
      completion: Promise.resolve({ status: "ok" as const, replyDisposition: "empty" as const }),
    }));
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const tasks: Promise<boolean>[] = [];
    const server = createServer((req, res) => {
      tasks.push(handler(req, res));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing listener");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/hooks/wake`, {
        method: "POST",
        headers: { Authorization: "Bearer hook-secret" },
        body: "{}",
      });
      expect(response.status).toBe(408);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toEqual({ ok: false, error: "request body timeout" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(await Promise.all(tasks)).toEqual([true]);
    }
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test.each([[503, "hook agent run did not start before admission timeout"]] as const)(
    "returns %s for typed agent admission failures",
    async (statusCode, error) => {
      readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
      const dispatchAgentHook = vi.fn(async () => ({
        ok: false as const,
        statusCode,
        error,
        runId: "run-1",
      }));
      const handler = createHooksHandler({ dispatchAgentHook });
      const req = createHookRequest({ url: "/hooks/agent" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(statusCode);
      expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error, runId: "run-1" }));
    },
  );

  test("shares hook auth rate-limit bucket across ipv4 and ipv4-mapped ipv6 forms", async () => {
    const handler = createHooksHandler({ bindHost: "127.0.0.1" });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "1.2.3.4",
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const mappedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "::ffff:1.2.3.4",
    });
    const { res: mappedRes, setHeader } = createResponse();
    const handled = await handler(mappedReq, mappedRes);

    expect(handled).toBe(true);
    expect(mappedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test("uses trusted proxy forwarded client ip for hook auth throttling", async () => {
    const handler = createHooksHandler({
      getClientIpConfig: () => ({ trustedProxies: ["10.0.0.1"] }),
    });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const forwardedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    const { res: forwardedRes, setHeader } = createResponse();
    const handled = await handler(forwardedReq, forwardedRes);

    expect(handled).toBe(true);
    expect(forwardedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test.each(["::"])(
    "returns unhandled when bindHost=%s sees a non-hook request URL",
    async (bindHost) => {
      const handler = createHooksHandler({ bindHost });
      const req = createHookRequest({ url: "/" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(end).not.toHaveBeenCalled();
    },
  );
});
