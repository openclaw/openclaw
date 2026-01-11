import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import plugin from "../../extensions/voice-call/index.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type Registered = {
  methods: Map<
    string,
    (ctx: Record<string, unknown>) => Promise<unknown> | unknown
  >;
  tools: unknown[];
};

function setup(config: Record<string, unknown>): Registered {
  const methods = new Map<
    string,
    (ctx: Record<string, unknown>) => Promise<unknown> | unknown
  >();
  const tools: unknown[] = [];
  plugin.register({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig: config,
    logger: noopLogger,
    registerGatewayMethod: (method, handler) => methods.set(method, handler),
    registerTool: (tool) => tools.push(tool),
    registerCli: () => {},
    registerService: () => {},
    resolvePath: (p: string) => p,
  });
  return { methods, tools };
}

describe("voice-call plugin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a log provider call and returns sid", async () => {
    const { methods } = setup({ provider: "log" });
    const handler = methods.get("voicecall.start");
    const respond = vi.fn();
    await handler({ params: { to: "+123", message: "Hi" }, respond });
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.sid).toMatch(/^log-/);
    expect(payload.status).toBe("queued");
  });

  it("fetches status via log provider", async () => {
    const { methods } = setup({ provider: "log" });
    const handler = methods.get("voicecall.status");
    const respond = vi.fn();
    await handler({ params: { sid: "log-1" }, respond });
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.status).toBe("mock");
  });

  it("calls Twilio start endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sid: "CA123",
        status: "queued",
        to: "+1555",
        from: "+1444",
      }),
    });
    // @ts-expect-error partial global
    global.fetch = fetch;
    const { methods } = setup({
      provider: "twilio",
      twilio: {
        accountSid: "AC123",
        authToken: "tok",
        from: "+1444",
        statusCallbackUrl: "https://callback.test/status",
      },
    });
    const handler = methods.get("voicecall.start");
    const respond = vi.fn();
    await handler({ params: { to: "+1555", message: "Hello" }, respond });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.sid).toBe("CA123");
    expect(payload.provider).toBe("twilio");
  });

  it("fetches Twilio status", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "in-progress", to: "+1" }),
    });
    // @ts-expect-error partial global
    global.fetch = fetch;
    const { methods } = setup({
      provider: "twilio",
      twilio: { accountSid: "AC123", authToken: "tok", from: "+1444" },
    });
    const handler = methods.get("voicecall.status");
    const respond = vi.fn();
    await handler({ params: { sid: "CA123" }, respond });
    expect(fetch).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls[0];
    expect(ok).toBe(true);
    expect(payload.status).toBe("in-progress");
  });
});
