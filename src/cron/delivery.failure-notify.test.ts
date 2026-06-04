import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
  deliverOutboundPayloads: vi.fn(),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({ kind: "identity" }),
  buildOutboundSessionContext: vi.fn().mockReturnValue({ kind: "session" }),
  createOutboundSendDeps: vi.fn().mockReturnValue({ kind: "deps" }),
  warn: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: mocks.resolveAgentOutboundIdentity,
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: mocks.buildOutboundSessionContext,
}));

vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: mocks.createOutboundSendDeps,
}));

vi.mock("../logging.js", () => ({
  getChildLogger: vi.fn(() => ({
    warn: mocks.warn,
  })),
}));

const { sendCronAnnouncePayloadStrict, sendFailureNotificationAnnounce } =
  await import("./delivery.js");

type DeliveryRequest = {
  abortSignal?: unknown;
  accountId?: string;
  bestEffort?: boolean;
  cfg?: unknown;
  channel?: string;
  deps?: unknown;
  identity?: unknown;
  mirror?: {
    agentId?: string;
    idempotencyKey?: string;
    sessionKey?: string;
    text?: string;
  };
  payloads?: unknown;
  session?: unknown;
  threadId?: number;
  to?: string;
};

type WarnMeta = { channel?: string; err?: string; to?: string };

function firstDeliveryRequest() {
  const [deliveryRequest] = mocks.deliverOutboundPayloads.mock.calls[0] as [DeliveryRequest];
  return deliveryRequest;
}

function firstWarnCall() {
  return mocks.warn.mock.calls[0] as [WarnMeta, string];
}

describe("sendFailureNotificationAnnounce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
      threadId: 42,
      mode: "explicit",
    });
    mocks.deliverOutboundPayloads.mockResolvedValue([{ ok: true }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers failure alerts to the resolved explicit target with strict send settings", async () => {
    const deps = {} as never;
    const cfg = {} as never;

    await sendFailureNotificationAnnounce(
      deps,
      cfg,
      "main",
      "job-1",
      { channel: "telegram", to: "123", accountId: "bot-a" },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(cfg, "main", {
      channel: "telegram",
      to: "123",
      accountId: "bot-a",
    });
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      sessionKey: "cron:job-1:failure",
    });
    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.cfg).toBe(cfg);
    expect(deliveryRequest.channel).toBe("telegram");
    expect(deliveryRequest.to).toBe("123");
    expect(deliveryRequest.accountId).toBe("bot-a");
    expect(deliveryRequest.threadId).toBe(42);
    expect(deliveryRequest.payloads).toEqual([{ text: "Cron failed" }]);
    expect(deliveryRequest.session).toEqual({ kind: "session" });
    expect(deliveryRequest.identity).toEqual({ kind: "identity" });
    expect(deliveryRequest.bestEffort).toBe(false);
    expect(deliveryRequest.deps).toEqual({ kind: "deps" });
    expect(deliveryRequest.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("mirrors successful announces into custom delivery session transcripts", async () => {
    const abortController = new AbortController();

    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: {
        channel: "telegram",
        sessionKey: "agent:main:session:daily-digest",
      },
      message: "Cron summary",
      abortSignal: abortController.signal,
    });

    const [deliveryRequest] = mocks.deliverOutboundPayloads.mock.calls[0] as [
      {
        mirror?: {
          agentId?: string;
          idempotencyKey?: string;
          sessionKey?: string;
          text?: string;
        };
      },
    ];
    expect(deliveryRequest.mirror).toMatchObject({
      sessionKey: "agent:main:session:daily-digest",
      agentId: "main",
      text: "Cron summary",
    });
    expect(deliveryRequest.mirror?.idempotencyKey).toMatch(/^cron-announce-mirror:v1:job-1:/);
  });

  it.each([
    {
      name: "legacy main alias",
      agentId: "ops",
      cfg: { session: { mainKey: "work" } },
      sessionKey: "main",
      expected: "agent:ops:work",
    },
    {
      name: "canonical main alias",
      agentId: "ops",
      cfg: { session: { mainKey: "work" } },
      sessionKey: "agent:ops:main",
      expected: "agent:ops:work",
    },
    {
      name: "unscoped custom session alias",
      agentId: "main",
      cfg: {},
      sessionKey: "daily-digest",
      expected: "agent:main:daily-digest",
    },
  ])(
    "canonicalizes cron mirror session keys for $name",
    async ({ agentId, cfg, sessionKey, expected }) => {
      const abortController = new AbortController();

      await sendCronAnnouncePayloadStrict({
        deps: {} as never,
        cfg: cfg as never,
        agentId,
        jobId: "job-1",
        target: {
          channel: "telegram",
          sessionKey,
        },
        message: "Cron summary",
        abortSignal: abortController.signal,
      });

      const deliveryRequest = firstDeliveryRequest();
      expect(deliveryRequest.mirror).toMatchObject({
        sessionKey: expected,
        agentId,
        text: "Cron summary",
      });
    },
  );

  it("canonicalizes failure alert mirror session keys with the configured main alias", async () => {
    const cfg = { session: { mainKey: "work" } };

    await sendFailureNotificationAnnounce(
      {} as never,
      cfg as never,
      "ops",
      "job-1",
      {
        channel: "telegram",
        sessionKey: "main",
      },
      "Cron failed",
    );

    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.mirror).toMatchObject({
      sessionKey: "agent:ops:work",
      agentId: "ops",
      text: "Cron failed",
    });
  });

  it("skips mirrors for routed peer session keys to avoid active chat lock races", async () => {
    const abortController = new AbortController();

    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: {
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123:thread:99",
      },
      message: "Cron summary",
      abortSignal: abortController.signal,
    });

    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.mirror).toBeUndefined();
  });

  it("skips mirrors for legacy dm routed peer session keys", async () => {
    const abortController = new AbortController();

    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: {
        channel: "telegram",
        sessionKey: "agent:main:telegram:dm:123:thread:99",
      },
      message: "Cron summary",
      abortSignal: abortController.signal,
    });

    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.mirror).toBeUndefined();
  });

  it.each([
    "agent:main:telegram:group:-100123:topic:77",
    "agent:main:slack:channel:general:thread:1699999999.0001",
  ])("skips mirrors for routed group/channel session key %s", async (sessionKey) => {
    const abortController = new AbortController();

    await sendCronAnnouncePayloadStrict({
      deps: {} as never,
      cfg: {} as never,
      agentId: "main",
      jobId: "job-1",
      target: {
        channel: "telegram",
        sessionKey,
      },
      message: "Cron summary",
      abortSignal: abortController.signal,
    });

    const deliveryRequest = firstDeliveryRequest();
    expect(deliveryRequest.mirror).toBeUndefined();
  });

  it("uses sessionKey for delivery-target resolution and outbound context", async () => {
    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      {
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123:thread:99",
      },
      "Cron failed",
    );

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith({} as never, "main", {
      channel: "telegram",
      to: undefined,
      accountId: undefined,
      sessionKey: "agent:main:telegram:direct:123:thread:99",
    });
    expect(mocks.buildOutboundSessionContext).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:123:thread:99",
    });
  });

  it("does not send when target resolution fails", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: false,
      error: new Error("target missing"),
    });

    await sendFailureNotificationAnnounce(
      {} as never,
      {} as never,
      "main",
      "job-1",
      { channel: "telegram", to: "123" },
      "Cron failed",
    );

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      { error: "target missing" },
      "cron: failed to resolve failure destination target",
    );
  });

  it("swallows outbound delivery errors after logging", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValue(new Error("send failed"));

    await expect(
      sendFailureNotificationAnnounce(
        {} as never,
        {} as never,
        "main",
        "job-1",
        { channel: "telegram", to: "123" },
        "Cron failed",
      ),
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [warnMeta, warnMessage] = firstWarnCall();
    expect(warnMeta.err).toBe("send failed");
    expect(warnMeta.channel).toBe("telegram");
    expect(warnMeta.to).toBe("123");
    expect(warnMessage).toBe("cron: failure destination announce failed");
  });
});
