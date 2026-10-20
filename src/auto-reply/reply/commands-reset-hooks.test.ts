import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { expectObjectFields, mockCall } from "../../test-utils/mock-call-assertions.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-soft-reset-tombstone-");

const triggerInternalHookMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const routeReplyMock = vi.hoisted(() =>
  vi.fn<
    (params: unknown) => Promise<{
      ok: boolean;
      delivered: boolean;
      messageId?: string;
      suppressed?: boolean;
    }>
  >(async () => ({ ok: true, delivered: true, messageId: "reset-hook-1" })),
);
const resetMocks = vi.hoisted(() => ({
  resetConfiguredBindingTargetInPlace: vi.fn().mockResolvedValue({ ok: true as const }),
  resolveBoundAcpThreadSessionKey: vi.fn(async (): Promise<string | undefined> => undefined),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (
    type: string,
    action: string,
    sessionKey: string,
    context: Record<string, unknown>,
  ) => ({
    type,
    action,
    sessionKey,
    context,
    timestamp: new Date(0),
    messages: [],
  }),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../channels/plugins/binding-targets.js", () => ({
  resetConfiguredBindingTargetInPlace: resetMocks.resetConfiguredBindingTargetInPlace,
}));

vi.mock("./commands-acp/targets.js", () => ({
  resolveBoundAcpThreadSessionKey: resetMocks.resolveBoundAcpThreadSessionKey,
}));

vi.mock("./route-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./route-reply.js")>()),
  routeReply: (params: unknown) => routeReplyMock(params),
}));

function buildResetParams(
  commandBody: string,
  cfg: OpenClawConfig = resetCommandConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    SessionKey: "agent:main:main",
    ...ctxOverrides,
  } as MsgContext;

  return {
    ctx,
    cfg,
    command: {
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim(),
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: ctx.SenderId ?? "123",
      channel: ctx.Surface ?? "whatsapp",
      channelId: ctx.Surface ?? "whatsapp",
      surface: ctx.Surface ?? "whatsapp",
      ownerList: [],
      from: ctx.From ?? "sender",
      to: ctx.To ?? "bot",
      resetHookTriggered: false,
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    agentId: "main",
    workspaceDir: "/tmp/openclaw-commands",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

function buildAcpResetParams(command: string) {
  return buildResetParams(
    command,
    {
      commands: { text: true },
      channels: { discord: { allowFrom: ["*"] } },
    },
    { Provider: "discord", Surface: "discord", CommandSource: "native" },
  );
}

function cliSession(
  sessionId: string,
  updatedAt = 1,
): NonNullable<HandleCommandsParams["sessionEntry"]> {
  const cliId = `cli-${sessionId}`;
  return {
    sessionId,
    updatedAt,
    cliSessionIds: { "claude-cli": cliId },
    cliSessionBindings: {
      "claude-cli": { sessionId: cliId, extraSystemPromptHash: `hash-${sessionId}` },
    },
    claudeCliSessionId: cliId,
  };
}

function expectCliSessionCleared(entry: HandleCommandsParams["sessionEntry"]) {
  expect(entry?.cliSessionIds).toBeUndefined();
  expect(entry?.cliSessionBindings).toBeUndefined();
  expect(entry?.claudeCliSessionId).toBeUndefined();
}

const requireRecord = createRequireRecord("object", "expected-label");

function firstHookEvent(): Record<string, unknown> {
  return requireRecord(mockCall(triggerInternalHookMock)[0], "hook event");
}

const resetCommandConfig: OpenClawConfig = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
};
const acpSessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
function queueHookReply() {
  triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
    event.messages.push("Reset hook says hi");
  });
}

describe("handleCommands reset hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({ ok: true });
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(undefined);
    triggerInternalHookMock.mockResolvedValue(undefined);
    routeReplyMock.mockResolvedValue({ ok: true, delivered: true, messageId: "reset-hook-1" });
  });

  it.each([false, true])("triggers /new hooks with native=%s", async (native) => {
    const target = "agent:main:telegram:direct:123";
    const params = native
      ? buildResetParams(
          "/new",
          {
            commands: { text: true },
            channels: { telegram: { allowFrom: ["*"] } },
          },
          {
            Provider: "telegram",
            Surface: "telegram",
            CommandSource: "native",
            CommandTargetSessionKey: target,
            SessionKey: "telegram:slash:123",
            SenderId: "123",
            From: "telegram:123",
            To: "slash:123",
          },
        )
      : buildResetParams("/new take notes");
    if (native) {
      params.sessionKey = target;
    }
    await maybeHandleResetCommand(params);
    const event = firstHookEvent();
    expectObjectFields(event, {
      type: "command",
      action: "new",
      ...(native ? { sessionKey: target } : {}),
    });
    if (native) {
      expectObjectFields(event.context, { workspaceDir: "/tmp/openclaw-commands" });
    }
  });

  it.each(["/reset", "/reset soft"])(
    "stops %s before reset effects when canceled during binding lookup",
    async (command) => {
      const lookup = createDeferred<string | undefined>();
      const started = createDeferred();
      const controller = new AbortController();
      const reason = new Error("reset canceled during binding lookup");
      resetMocks.resolveBoundAcpThreadSessionKey.mockImplementationOnce(() => {
        started.resolve();
        return lookup.promise;
      });
      const params = buildResetParams(command);
      params.opts = { abortSignal: controller.signal };
      const result = maybeHandleResetCommand(params);
      const failure = expect(result).rejects.toBe(reason);
      await started.promise;
      controller.abort(reason);
      lookup.resolve(command === "/reset" ? "agent:main:acp:bound" : undefined);
      await failure;
      expect(resetMocks.resetConfiguredBindingTargetInPlace).not.toHaveBeenCalled();
      expect(triggerInternalHookMock).not.toHaveBeenCalled();
      expect(params.command.softResetTriggered).toBeUndefined();
    },
  );

  it("uses gateway session reset for bound ACP sessions", async () => {
    const preparedSession = {
      sessionKey: acpSessionKey,
      sessionId: "session-after-acp-reset",
      lifecycleRevision: "after-acp-reset",
      storePath: "/tmp/claude-sessions.json",
    };
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({
      ok: true,
      ...preparedSession,
    });
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(acpSessionKey);
    const onSessionPrepared = vi.fn();
    const params = buildAcpResetParams("/reset");
    params.opts = { onSessionPrepared } as never;

    const result = await maybeHandleResetCommand(params);

    expectObjectFields(mockCall(resetMocks.resetConfiguredBindingTargetInPlace)[0], {
      cfg: params.cfg,
      sessionKey: acpSessionKey,
      reason: "reset",
      commandSource: "discord:native",
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ ACP session reset in place.", isStatusNotice: true },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(params.command.resetHookTriggered).toBe(true);
    expect(onSessionPrepared).toHaveBeenCalledWith(preparedSession);
  });

  it("keeps a failed ACP reset as a failure status notice", async () => {
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValueOnce({
      ok: false,
      error: "reset rejected",
    });
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue("agent:main:acp:bound");
    const params = buildResetParams("/reset");

    expect(await maybeHandleResetCommand(params)).toEqual({
      shouldContinue: false,
      reply: {
        text: "⚠️ ACP session reset failed. Check /acp status and try again.",
        isStatusNotice: true,
      },
    });
    expect(params.command.resetHookTriggered).not.toBe(true);
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
  });

  it("keeps tail dispatch after a bound ACP reset", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(acpSessionKey);
    const params = buildAcpResetParams("/new who are you");

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({ shouldContinue: false });
    expect(params.ctx).toMatchObject({
      Body: "who are you",
      CommandBody: "who are you",
      AcpDispatchTailAfterReset: true,
    });
  });

  it("forwards non-id sender fields when reset hooks emit routed replies", async () => {
    queueHookReply();
    const onObservedReplyDelivery = vi.fn();
    const params = buildResetParams("/new", resetCommandConfig, {
      SenderId: "id:whatsapp:123",
      SenderName: "Alice",
      SenderUsername: "alice_u",
      SenderE164: "+15551234567",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "group:ops",
      MessageThreadId: "thread-1",
    });
    params.opts = { onObservedReplyDelivery };

    const result = await maybeHandleResetCommand(params);

    expectObjectFields(mockCall(routeReplyMock)[0], {
      requesterSenderId: "id:whatsapp:123",
      requesterSenderName: "Alice",
      requesterSenderUsername: "alice_u",
      requesterSenderE164: "+15551234567",
      threadId: "thread-1",
    });
    expect(onObservedReplyDelivery).toHaveBeenCalledOnce();
    expect(result).toEqual({ shouldContinue: false });
  });

  it("falls back to the standard reset acknowledgement when the hook route fails", async () => {
    queueHookReply();
    routeReplyMock.mockResolvedValueOnce({ ok: false, delivered: false });
    const onObservedReplyDelivery = vi.fn();
    const params = buildResetParams("/new");
    params.opts = { onObservedReplyDelivery };

    const result = await maybeHandleResetCommand(params);

    expect(onObservedReplyDelivery).not.toHaveBeenCalled();
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ New session started.", isStatusNotice: true },
    });
  });

  it("prefers the target session entry when emitting reset hooks", async () => {
    const params = buildResetParams("/reset");
    params.sessionEntry = { sessionId: "wrapper-session", updatedAt: Date.now() };
    params.sessionStore = {
      "agent:main:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
      },
    };

    await maybeHandleResetCommand(params);

    const event = firstHookEvent();
    const context = requireRecord(event.context, "hook context");
    expectObjectFields(context.sessionEntry, { sessionId: "target-session" });
  });

  it("marks soft reset turns and emits reset hooks", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const params = buildResetParams("/reset soft");
    const sessionEntry = {
      ...cliSession("session-1", 0),
      lifecycleRevision: "soft-reset-revision",
    };
    params.sessionEntry = sessionEntry;
    params.sessionStore = { [params.sessionKey]: sessionEntry };
    params.storePath = storePath;
    await replaceSessionEntry({ sessionKey: params.sessionKey, storePath }, sessionEntry);

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    const event = firstHookEvent();
    expectObjectFields(event, { type: "command", action: "reset" });
    const context = requireRecord(event.context, "hook context");
    expectObjectFields(context.previousSessionEntry, { sessionId: "session-1" });
    expect(params.command).toMatchObject({
      resetHookTriggered: true,
      softResetTriggered: true,
      softResetTail: "",
    });
    expectCliSessionCleared(params.sessionEntry);
    expect(
      loadSessionEntry({ sessionKey: params.sessionKey, storePath })?.updatedAt,
    ).toBeGreaterThan(0);
  });

  it.each<[string, Partial<MsgContext>, boolean, boolean?]>([
    ["write scope", {}, false],
    ["admin scope", { GatewayClientScopes: ["operator.admin"] }, true],
    ["legacy empty scopes", { GatewayClientScopes: [] }, true],
    ["internal Provider remains authoritative", { Surface: "telegram" }, false],
    ["external Provider remains authoritative", { Provider: "telegram" }, true],
    ["missing Provider uses internal Surface", { Provider: undefined }, false],
    [
      "Gateway text command forwarded externally",
      {
        CommandBody: "/new Create a note",
        OriginatingChannel: "telegram",
      },
      false,
      true,
    ],
    [
      "external unauthorized text command with internal surface and origin",
      {
        CommandBody: "/new Create a note",
        Provider: "telegram",
        OriginatingChannel: "webchat",
        CommandAuthorized: false,
        GatewayClientScopes: undefined,
      },
      false,
      true,
    ],
  ])(
    "preserves reset authorization and denial routing: %s",
    async (_name, overrides, allowed, silent = false) => {
      const body = overrides.CommandBody ?? "/reset soft";
      const commandAuthorized = overrides.CommandAuthorized ?? true;
      const originatingChannel = overrides.OriginatingChannel;
      const params = buildResetParams(
        body,
        { commands: { text: true } },
        {
          Provider: "webchat",
          Surface: "webchat",
          OriginatingTo: originatingChannel ? "chat:reset-test" : undefined,
          ExplicitDeliverRoute: originatingChannel !== undefined,
          CommandSource: "text",
          CommandAuthorized: commandAuthorized,
          GatewayClientScopes: ["operator.write"],
          ...overrides,
        },
      );
      params.command = buildCommandContext({
        ctx: params.ctx,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        isGroup: false,
        triggerBodyNormalized: body,
        commandAuthorized,
      });
      params.sessionEntry = {
        sessionId: "existing-soft-session",
        lifecycleRevision: "existing-soft-generation",
        updatedAt: 1,
        cliSessionIds: { "claude-cli": "existing-cli-binding" },
      };
      const before = structuredClone(params.sessionEntry);

      const result = await maybeHandleResetCommand(params);

      if (allowed) {
        expect(result).toBeNull();
      } else if (silent) {
        expect(result).toStrictEqual({ shouldContinue: false });
      } else {
        expect(result?.shouldContinue).toBe(false);
        expect(result?.reply?.text).toMatch(/not authorized/i);
        expect(result?.reply?.text).toContain("operator.admin");
      }
      expect(params.sessionEntry).toMatchObject({
        sessionId: before.sessionId,
        lifecycleRevision: before.lifecycleRevision,
      });
      expect(params.command.softResetTriggered === true).toBe(allowed);
      expect(triggerInternalHookMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(routeReplyMock).not.toHaveBeenCalled();
      expect(resetMocks.resetConfiguredBindingTargetInPlace).not.toHaveBeenCalled();
      if (allowed) {
        expect(params.sessionEntry.cliSessionIds).toBeUndefined();
      } else {
        expect(params.sessionEntry).toEqual(before);
      }
    },
  );

  it("clears both sessionStore and sessionEntry when they are distinct objects", async () => {
    const params = buildResetParams("/reset soft");
    params.sessionEntry = cliSession("session-direct");
    params.sessionStore = {
      [params.sessionKey]: cliSession("session-store", 2),
    };

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expectCliSessionCleared(params.sessionEntry);
    expectCliSessionCleared(params.sessionStore?.[params.sessionKey]);
  });

  it("rejects soft reset for bound ACP sessions", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(acpSessionKey);
    const params = buildAcpResetParams("/reset soft");
    expect(await maybeHandleResetCommand(params)).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(resetMocks.resetConfiguredBindingTargetInPlace).not.toHaveBeenCalled();
  });
});
