import { expect, vi, type Mock } from "vitest";
import type { MsgContext } from "../templating.js";

export function buildGetReplyCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    ChatType: "direct",
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    SessionKey: "agent:main:telegram:123",
    From: "telegram:user:42",
    To: "telegram:123",
    Timestamp: 1710000000000,
    ...overrides,
  };
}

export function createGetReplySessionState() {
  return {
    sessionCtx: {},
    sessionEntry: {},
    previousSessionEntry: {},
    sessionStore: {},
    sessionKey: "agent:main:telegram:123",
    sessionId: "session-1",
    isNewSession: false,
    resetTriggered: false,
    systemSent: false,
    abortedLastRun: false,
    storePath: "/tmp/sessions.json",
    sessionScope: "per-chat",
    groupResolution: undefined,
    isGroup: false,
    triggerBodyNormalized: "",
    bodyStripped: "",
  };
}

export function registerGetReplyRuntimeOverrides(handles: {
  resolveReplyDirectives: (...args: unknown[]) => unknown;
  initSessionState: (...args: unknown[]) => unknown;
}): void {
  vi.doMock("./get-reply-directives.js", () => ({
    resolveReplyDirectives: (...args: unknown[]) => handles.resolveReplyDirectives(...args),
  }));
  vi.doMock("./get-reply-inline-actions.js", () => ({
    handleInlineActions: vi.fn(async () => ({ kind: "reply", reply: { text: "ok" } })),
  }));
  vi.doMock("./session.js", () => ({
    initSessionState: (...args: unknown[]) => handles.initSessionState(...args),
  }));
}

export function expectResolvedTelegramTimezone(
  resolveReplyDirectives: Mock,
  userTimezone = "America/New_York",
): void {
  expect(resolveReplyDirectives).toHaveBeenCalledWith(
    expect.objectContaining({
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          telegram: expect.objectContaining({
            botToken: "resolved-telegram-token",
          }),
        }),
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            userTimezone,
          }),
        }),
      }),
    }),
  );
}
