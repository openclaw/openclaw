import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
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

function createAgentDispatch() {
  return vi.fn((_value: HookAgentDispatchPayload) => ({
    ok: true as const,
    runId: "run-1",
    completion: Promise.resolve({ status: "ok" as const, replyDisposition: "empty" as const }),
  }));
}

function deliveryMapping(id: string, target: Partial<HookMappingResolved>): HookMappingResolved {
  return {
    id,
    matchPath: id,
    action: "agent",
    wakeMode: "now",
    messageTemplate: "Mapped",
    ...target,
  };
}

function createDeliveryHandler(params?: {
  mappings?: HookMappingResolved[];
  agentPolicy?: Partial<HooksConfigResolved["agentPolicy"]>;
}) {
  const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
  const dispatchAgentHook = createAgentDispatch();
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

async function dispatchPayload(
  handler: ReturnType<typeof createHooksRequestHandler>,
  payload: Record<string, unknown>,
  path = "/hooks/agent",
  error?: string,
) {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: payload });
  const response = createResponse();
  await handler(createHookRequest({ url: path }), response.res);
  expect(response.res.statusCode).toBe(error ? 400 : 200);
  if (error) {
    expect(response.getBody()).toContain(error);
  }
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
    const send = (payload: Record<string, unknown> = {}, error?: string) =>
      dispatchPayload(handler, { message: "Direct", ...payload }, "/hooks/agent", error);
    await send();
    expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });
    await send({ to: "sensitive-recipient" }, "channel and to must be set together");
    await send({ to: 123 }, "to must be a non-empty string");
    await send({ channel: "delivery-test" }, "channel and to must be set together");
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    await send({ deliver: false, channel: "stale-channel", to: "sensitive-recipient" });
    expect(dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      deliver: false,
      channel: "last",
      to: undefined,
      delivery: { mode: "none" },
    });
    await send({ channel: "delivery-test", to: "123456", accountId: "work" });
    expect(dispatchAgentHook.mock.calls[2]?.[0]).toMatchObject({
      accountId: "work",
      delivery: { mode: "announce", channel: "delivery-test", to: "123456", accountId: "work" },
    });
  });

  test("preserves mapped delivery semantics while binding the CronJob target", async () => {
    const mapped = createDeliveryHandler({
      mappings: [
        deliveryMapping("channel-only", { channel: "delivery-test" }),
        deliveryMapping("recipient-only", { to: "123456" }),
      ],
    });
    await dispatchPayload(mapped.handler, {}, "/hooks/channel-only");
    await dispatchPayload(mapped.handler, {}, "/hooks/recipient-only");
    expect(mapped.dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "delivery-test", to: undefined },
    });
    expect(mapped.dispatchAgentHook.mock.calls[1]?.[0]).toMatchObject({
      delivery: { mode: "announce", channel: "last", to: "123456" },
    });
    const optedOut = createDeliveryHandler({
      mappings: [deliveryMapping("channel-only", { deliver: false, channel: "delivery-test" })],
    });
    await dispatchPayload(optedOut.handler, {}, "/hooks/channel-only");
    expect(optedOut.dispatchAgentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        channel: "delivery-test",
        delivery: { mode: "none" },
      }),
    );
  });

  test.each([
    ["/hooks/agent", { message: "Direct", agentId: "  " }],
    ["/hooks/wake", { text: "Wake", agentId: "  " }],
  ])("rejects a blank direct agentId on %s without dispatch", async (path, payload) => {
    const { handler, dispatchAgentHook, dispatchWakeHook } = createDeliveryHandler();
    await dispatchPayload(handler, payload, path, "agentId must be a non-empty string");
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
    await dispatchPayload(handler, {}, "/hooks/mapped-unknown-agent");
    expect(dispatchAgentHook).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", effectiveAgentId: "main" }),
    );
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
    const response = await dispatchPayload(
      handler,
      { message: "Direct", agentId: "research" },
      "/hooks/agent",
      error,
    );
    expect(response.getBody()).not.toContain("agentId is required");
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });
});

async function expectAuthFailure(
  handler: ReturnType<typeof createHooksHandler>,
  request: Parameters<typeof createHookRequest>[0],
  status: number,
) {
  const response = createResponse();
  expect(
    await handler(createHookRequest({ authorization: "Bearer wrong", ...request }), response.res),
  ).toBe(true);
  expect(response.res.statusCode).toBe(status);
  if (status === 429) {
    const value = response.setHeader.mock.calls.find(([name]) => name === "Retry-After")?.[1];
    expect(typeof value).toBe("string");
    expect(Number.parseInt(String(value), 10)).toBeGreaterThan(0);
  }
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn(() => ({ eventOutcome: "queued" as const }));
    const dispatchAgentHook = createAgentDispatch();
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const tasks: Promise<boolean>[] = [];
    const server = createServer((req, res) => {
      tasks.push(handler(req, res));
    });
    const origin = await listenLoopback(server);
    try {
      const response = await fetch(`${origin}/hooks/wake`, {
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

  test("returns 503 for typed agent admission failures", async () => {
    const statusCode = 503;
    const error = "hook agent run did not start before admission timeout";
    readJsonBodyMock.mockResolvedValue({ ok: true, value: { message: "Dispatch" } });
    const dispatchAgentHook = vi.fn(async () => ({
      ok: false as const,
      statusCode: 503 as const,
      error,
      runId: "run-1",
    }));
    const handler = createHooksHandler({ dispatchAgentHook });
    const { res, end } = createResponse();
    expect(await handler(createHookRequest({ url: "/hooks/agent" }), res)).toBe(true);
    expect(res.statusCode).toBe(statusCode);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error, runId: "run-1" }));
  });

  test.each(["mapped-ipv6", "trusted-proxy"])(
    "shares the hook auth bucket for %s",
    async (form) => {
      const proxy = form === "trusted-proxy";
      const handler = createHooksHandler(
        proxy
          ? { getClientIpConfig: () => ({ trustedProxies: ["10.0.0.1"] }) }
          : { bindHost: "127.0.0.1" },
      );
      const first = proxy
        ? { remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } }
        : { remoteAddress: "1.2.3.4" };
      const next = proxy
        ? { remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }
        : { remoteAddress: "::ffff:1.2.3.4" };
      for (let i = 0; i < 20; i++) {
        await expectAuthFailure(handler, first, 401);
      }
      await expectAuthFailure(handler, next, 429);
    },
  );

  test("returns unhandled for a non-hook URL on an IPv6 listener", async () => {
    const handler = createHooksHandler({ bindHost: "::" });
    const { res, end } = createResponse();
    expect(await handler(createHookRequest({ url: "/" }), res)).toBe(false);
    expect(end).not.toHaveBeenCalled();
  });
});
