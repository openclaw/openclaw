import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveMainSessionKey } from "../../config/sessions.js";
import {
  peekSystemEvents,
  drainSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { cronHandlers } from "./cron.js";
import { systemHandlers } from "./system.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const cfg = {} as unknown as OpenClawConfig;
const mainKey = resolveMainSessionKey(cfg);

function createMockOptions(params: Record<string, unknown>): GatewayRequestHandlerOptions & {
  responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }>;
  cronWakeMock: ReturnType<typeof vi.fn>;
} {
  const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond: RespondFn = (ok, payload, error) => {
    responses.push({ ok, payload, error });
  };
  const cronWakeMock = vi.fn(() => ({ ok: true }));
  return {
    req: { type: "req" as const, id: "test-1", method: "wake", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      cron: { wake: cronWakeMock },
    } as unknown as GatewayRequestHandlerOptions["context"],
    responses,
    cronWakeMock,
  };
}

describe("wake handler (cronHandlers)", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("calls context.cron.wake for fan-out when no sessionKey provided", async () => {
    const opts = createMockOptions({ text: "hello from wake", mode: "now" });
    await cronHandlers.wake(opts);

    expect(opts.responses).toHaveLength(1);
    expect(opts.responses[0].ok).toBe(true);
    expect(opts.responses[0].payload).toEqual({ ok: true });
    expect(opts.cronWakeMock).toHaveBeenCalledWith({
      mode: "now",
      text: "hello from wake",
    });
  });

  it("enqueues event to custom session when sessionKey provided", async () => {
    const customKey = "agent:main:discord:channel:12345";
    const opts = createMockOptions({
      text: "targeted event",
      mode: "now",
      sessionKey: customKey,
    });
    await cronHandlers.wake(opts);

    expect(opts.responses).toHaveLength(1);
    expect(opts.responses[0].ok).toBe(true);
    expect(opts.responses[0].payload).toEqual({ ok: true, mode: "now" });

    // Targeted path bypasses context.cron.wake
    expect(opts.cronWakeMock).not.toHaveBeenCalled();

    // Custom session should have the event
    expect(peekSystemEvents(customKey)).toEqual(["targeted event"]);
    drainSystemEvents(customKey);
  });

  it("rejects missing mode", async () => {
    const opts = createMockOptions({ text: "no mode" });
    await cronHandlers.wake(opts);

    expect(opts.responses).toHaveLength(1);
    expect(opts.responses[0].ok).toBe(false);
    expect(opts.responses[0].error).toBeDefined();
  });

  it("rejects empty text", async () => {
    const opts = createMockOptions({ text: "", mode: "now" });
    await cronHandlers.wake(opts);

    expect(opts.responses).toHaveLength(1);
    expect(opts.responses[0].ok).toBe(false);
    expect(opts.responses[0].error).toBeDefined();
  });

  it("trims sessionKey whitespace", async () => {
    const opts = createMockOptions({
      text: "padded key",
      mode: "now",
      sessionKey: "  agent:main:discord:channel:999  ",
    });
    await cronHandlers.wake(opts);

    expect(opts.responses[0].ok).toBe(true);
    expect(peekSystemEvents("agent:main:discord:channel:999")).toEqual(["padded key"]);
    expect(opts.cronWakeMock).not.toHaveBeenCalled();
    drainSystemEvents("agent:main:discord:channel:999");
  });

  it("respects mode next-heartbeat with sessionKey", async () => {
    const opts = createMockOptions({
      text: "deferred",
      mode: "next-heartbeat",
      sessionKey: "agent:main:discord:channel:888",
    });
    await cronHandlers.wake(opts);

    expect(opts.responses[0].ok).toBe(true);
    expect(opts.responses[0].payload).toEqual({ ok: true, mode: "next-heartbeat" });
    expect(peekSystemEvents("agent:main:discord:channel:888")).toEqual(["deferred"]);
    drainSystemEvents("agent:main:discord:channel:888");
  });

  it("uses fan-out for next-heartbeat without sessionKey", async () => {
    const opts = createMockOptions({
      text: "deferred fan-out",
      mode: "next-heartbeat",
    });
    await cronHandlers.wake(opts);

    expect(opts.responses[0].ok).toBe(true);
    expect(opts.cronWakeMock).toHaveBeenCalledWith({
      mode: "next-heartbeat",
      text: "deferred fan-out",
    });
  });
});

describe("system-event handler sessionKey support", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  it("routes non-node events to custom session when sessionKey provided", async () => {
    const customKey = "agent:main:discord:channel:456";
    const opts = createMockOptions({ text: "custom session event", sessionKey: customKey });
    opts.req = { ...opts.req, method: "system-event" };
    opts.context = {
      broadcast: vi.fn(),
      incrementPresenceVersion: vi.fn(() => 1),
      getHealthVersion: vi.fn(() => 1),
    } as unknown as GatewayRequestHandlerOptions["context"];

    await systemHandlers["system-event"](opts);

    expect(opts.responses[0].ok).toBe(true);
    expect(peekSystemEvents(customKey)).toEqual(["custom session event"]);
    expect(peekSystemEvents(mainKey)).toEqual([]);
    drainSystemEvents(customKey);
  });

  it("routes to main session when no sessionKey provided", async () => {
    const opts = createMockOptions({ text: "main session event" });
    opts.req = { ...opts.req, method: "system-event" };
    opts.context = {
      broadcast: vi.fn(),
      incrementPresenceVersion: vi.fn(() => 1),
      getHealthVersion: vi.fn(() => 1),
    } as unknown as GatewayRequestHandlerOptions["context"];

    await systemHandlers["system-event"](opts);

    expect(opts.responses[0].ok).toBe(true);
    expect(peekSystemEvents(mainKey)).toEqual(["main session event"]);
  });

  it("node presence events always use main session regardless of sessionKey", async () => {
    const customKey = "agent:main:discord:channel:789";
    const opts = createMockOptions({
      text: "Node: TestHost",
      sessionKey: customKey,
      host: "TestHost",
    });
    opts.req = { ...opts.req, method: "system-event" };
    opts.context = {
      broadcast: vi.fn(),
      incrementPresenceVersion: vi.fn(() => 1),
      getHealthVersion: vi.fn(() => 1),
    } as unknown as GatewayRequestHandlerOptions["context"];

    await systemHandlers["system-event"](opts);

    expect(opts.responses[0].ok).toBe(true);
    // Node events should NOT go to the custom session
    expect(peekSystemEvents(customKey)).toEqual([]);
    // They should go to main session (if there was a presence change)
    // The actual presence change logic is complex, but the key assertion
    // is that customKey is NOT used for node presence lines
  });
});
