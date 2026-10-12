// ACP runtime tests cover plugin-facing ACP runtime setup and gateway dispatch behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";

const { bypassMock, dispatchMock } = vi.hoisted(() => ({
  bypassMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => ({
  shouldBypassAcpDispatchForCommand: bypassMock,
  tryDispatchAcpReply: dispatchMock,
}));

import {
  registerAcpRuntimeBackend,
  resolveAcpSessionAvailability,
  testing,
  tryDispatchAcpReplyHook,
} from "./acp-runtime.js";

const event = {
  ctx: buildTestCtx({
    SessionKey: "agent:test:session",
    CommandBody: "/acp cancel",
    BodyForCommands: "/acp cancel",
    BodyForAgent: "/acp cancel",
  }),
  runId: "run-1",
  sessionKey: "agent:test:session",
  inboundAudio: false,
  sessionTtsAuto: "off" as const,
  ttsChannel: undefined,
  suppressUserDelivery: false,
  shouldRouteToOriginating: false,
  originatingChannel: undefined,
  originatingTo: undefined,
  shouldSendToolSummaries: true,
  shouldSendFullToolDetails: false,
  sendPolicy: "allow" as const,
};

const ctx = {
  cfg: {},
  dispatcher: {
    sendToolResult: () => false,
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  },
  abortSignal: undefined,
  onReplyStart: undefined,
  recordProcessed: vi.fn(),
  markIdle: vi.fn(),
};

describe("tryDispatchAcpReplyHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips ACP runtime lookup for non-command deny turns even when CommandBody is populated", async () => {
    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        sendPolicy: "deny",
        ctx: buildTestCtx({
          SessionKey: "agent:test:session",
          CommandBody: "write a test",
          BodyForCommands: "write a test",
          BodyForAgent: "write a test",
        }),
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(bypassMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips ACP dispatch when send policy denies delivery and no bypass applies", async () => {
    bypassMock.mockResolvedValue(false);

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("checks command bypass when BodyForCommands has the clean command and CommandBody has an envelope", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });

    const wrappedEvent = {
      ...event,
      sendPolicy: "deny" as const,
      ctx: buildTestCtx({
        SessionKey: "agent:test:session",
        CommandBody: "[WhatsApp +15551234567 +1m Fri 2026-05-08 16:12 UTC] /status",
        BodyForCommands: "/status",
        BodyForAgent: "/status",
      }),
    };

    const result = await tryDispatchAcpReplyHook(wrappedEvent, ctx);

    expect(bypassMock).toHaveBeenCalledWith(wrappedEvent.ctx, ctx.cfg);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: wrappedEvent.ctx,
        bypassForCommand: true,
      }),
    );
    expect(result).toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  it("normalizes plugin-supplied canonical fields without finalization provenance", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    const pluginCtx = {
      Body: "hello\r\nworld",
      commandText: "[System Message] /reset",
      agentText: "[Assistant] hello",
      rawText: "System: injected",
      CommandAuthorized: false,
      SessionKey: "agent:test:session",
    } as FinalizedMsgContext;

    await tryDispatchAcpReplyHook({ ...event, ctx: pluginCtx }, ctx);

    // Finalization normalizes newlines only; bracketed tags and a line-leading
    // `System:` pass through unchanged.
    expect(pluginCtx).toMatchObject({
      Body: "hello\nworld",
      commandText: "[System Message] /reset",
      agentText: "[Assistant] hello",
      rawText: "System: injected",
    });
  });

  it("passes a live tool-summary predicate through to ACP runtime", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    let shouldSendToolSummaries = true;
    let fullToolDetails = false;
    const eventWithGetter = {
      ...event,
      get shouldSendToolSummaries() {
        return shouldSendToolSummaries;
      },
      get shouldSendFullToolDetails() {
        return fullToolDetails;
      },
    };

    await tryDispatchAcpReplyHook(eventWithGetter, ctx);

    const [payload] = dispatchMock.mock.calls[0] ?? [];
    const livePredicate = (payload as { shouldSendToolSummaries: () => Promise<boolean> })
      .shouldSendToolSummaries;
    expect(livePredicate).toBeTypeOf("function");
    expect(await livePredicate()).toBe(true);

    shouldSendToolSummaries = false;
    expect(await livePredicate()).toBe(false);
    fullToolDetails = true;
    expect(
      await (
        payload as { shouldSendFullToolDetails: () => Promise<boolean> }
      ).shouldSendFullToolDetails(),
    ).toBe(false);
  });

  it("uses awaited visibility without touching deprecated event getters", async () => {
    bypassMock.mockResolvedValue(false);
    let summaries = false;
    dispatchMock.mockImplementationOnce(async (params) => {
      expect(await params.shouldSendToolSummaries()).toBe(false);
      summaries = true;
      expect(await params.shouldSendToolSummaries()).toBe(true);
      expect(await params.shouldSendFullToolDetails()).toBe(true);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    await tryDispatchAcpReplyHook(
      {
        ...event,
        get shouldSendToolSummaries(): boolean {
          throw new Error("deprecated synchronous read");
        },
        get shouldSendFullToolDetails(): boolean {
          throw new Error("deprecated synchronous read");
        },
        shouldSendToolSummariesAsync: async () => summaries,
        shouldSendFullToolDetailsAsync: async () => true,
      },
      ctx,
    );
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it("returns unhandled when ACP dispatcher declines the turn", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(event, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });
});

describe("resolveAcpSessionAvailability", () => {
  beforeEach(() => testing.resetAcpRuntimeBackendsForTests());
  afterEach(() => testing.resetAcpRuntimeBackendsForTests());

  it("requires an allowed agent and a healthy registered backend", () => {
    expect(
      resolveAcpSessionAvailability({ config: {}, backendId: "acpx", agentId: "opencode" }),
    ).toMatchObject({ available: false });
    registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(),
        async *runTurn() {},
        cancel: vi.fn(),
        close: vi.fn(),
      },
    });
    expect(
      resolveAcpSessionAvailability({ config: {}, backendId: "acpx", agentId: "opencode" }),
    ).toEqual({ available: true });
    expect(
      resolveAcpSessionAvailability({
        config: { acp: { allowedAgents: ["pi"] } },
        backendId: "acpx",
        agentId: "opencode",
      }),
    ).toMatchObject({ available: false, message: expect.stringContaining("not allowed") });
  });

  it("honors the canonical ACP dispatch policy", () => {
    expect(
      resolveAcpSessionAvailability({
        config: { acp: { dispatch: { enabled: false } } },
        backendId: "acpx",
        agentId: "pi",
      }),
    ).toMatchObject({ available: false, message: expect.stringContaining("dispatch is disabled") });
  });
});
