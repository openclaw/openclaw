// Tests reset hook emission and cleanup around reset commands.
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
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

vi.mock("../commands-registry.js", () => ({
  normalizeCommandBody: (raw: string) => raw.trim(),
  shouldHandleTextCommands: () => true,
}));

vi.mock("../../channels/plugins/binding-targets.js", () => ({
  resetConfiguredBindingTargetInPlace: resetMocks.resetConfiguredBindingTargetInPlace,
}));

vi.mock("./commands-acp/targets.js", () => ({
  resolveBoundAcpThreadSessionKey: resetMocks.resolveBoundAcpThreadSessionKey,
}));

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => [],
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
  updatedAt: number,
  cliId: string,
  hash: string,
): NonNullable<HandleCommandsParams["sessionEntry"]> {
  return {
    sessionId,
    updatedAt,
    cliSessionIds: { "claude-cli": cliId },
    cliSessionBindings: { "claude-cli": { sessionId: cliId, extraSystemPromptHash: hash } },
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

describe("handleCommands reset hooks", () => {
  let clearBootstrapSnapshotSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    clearBootstrapSnapshotSpy = vi.spyOn(bootstrapCache, "clearBootstrapSnapshot");
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({ ok: true });
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(undefined);
    triggerInternalHookMock.mockResolvedValue(undefined);
    routeReplyMock.mockResolvedValue({
      ok: true,
      delivered: true,
      messageId: "reset-hook-1",
    });
  });

  afterEach(() => {
    clearBootstrapSnapshotSpy.mockRestore();
  });

  it("triggers hooks for /new commands", async () => {
    const cases = [
      {
        name: "text command with arguments",
        params: buildResetParams("/new take notes", resetCommandConfig),
        expectedEvent: { type: "command", action: "new" },
      },
      {
        name: "native command routed to target session",
        params: (() => {
          const params = buildResetParams(
            "/new",
            {
              commands: { text: true },
              channels: { telegram: { allowFrom: ["*"] } },
            } as OpenClawConfig,
            {
              Provider: "telegram",
              Surface: "telegram",
              CommandSource: "native",
              CommandTargetSessionKey: "agent:main:telegram:direct:123",
              SessionKey: "telegram:slash:123",
              SenderId: "123",
              From: "telegram:123",
              To: "slash:123",
              CommandAuthorized: true,
            },
          );
          params.sessionKey = "agent:main:telegram:direct:123";
          return params;
        })(),
        expectedEvent: {
          type: "command",
          action: "new",
          sessionKey: "agent:main:telegram:direct:123",
        },
        expectedContext: {
          workspaceDir: "/tmp/openclaw-commands",
        },
      },
    ] as const;

    for (const testCase of cases) {
      await maybeHandleResetCommand(testCase.params);
      const event = firstHookEvent();
      expectObjectFields(event, testCase.expectedEvent);
      if ("expectedContext" in testCase) {
        expectObjectFields(event.context, testCase.expectedContext);
      }
      triggerInternalHookMock.mockClear();
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
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({
      ok: true,
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "session-after-acp-reset",
      lifecycleRevision: "after-acp-reset",
      storePath: "/tmp/claude-sessions.json",
    });
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const onSessionPrepared = vi.fn();
    const params = buildAcpResetParams("/reset");
    params.opts = { onSessionPrepared } as never;

    const result = await maybeHandleResetCommand(params);

    const resetArgs = requireRecord(
      mockCall(resetMocks.resetConfiguredBindingTargetInPlace)[0],
      "reset args",
    );
    if (!resetArgs.cfg || typeof resetArgs.cfg !== "object") {
      throw new Error("expected reset config");
    }
    expectObjectFields(resetArgs, {
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      reason: "reset",
      commandSource: "discord:native",
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ ACP session reset in place.", isStatusNotice: true },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(params.command.resetHookTriggered).toBe(true);
    expect(onSessionPrepared).toHaveBeenCalledWith({
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "session-after-acp-reset",
      lifecycleRevision: "after-acp-reset",
      storePath: "/tmp/claude-sessions.json",
    });
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
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildAcpResetParams("/new who are you");

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({ shouldContinue: false });
    expect(params.ctx.Body).toBe("who are you");
    expect(params.ctx.CommandBody).toBe("who are you");
    expect(params.ctx.AcpDispatchTailAfterReset).toBe(true);
  });

  it("forwards non-id sender fields when reset hooks emit routed replies", async () => {
    triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
      event.messages.push("Reset hook says hi");
    });
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

  it.each([["failed", { ok: false, delivered: false }]] as const)(
    "falls back to the standard reset acknowledgement when the hook route is %s",
    async (_name, routeResult) => {
      triggerInternalHookMock.mockImplementationOnce(async (event: { messages: string[] }) => {
        event.messages.push("Reset hook says hi");
      });
      routeReplyMock.mockResolvedValueOnce(routeResult);
      const onObservedReplyDelivery = vi.fn();
      const params = buildResetParams("/new");
      params.opts = { onObservedReplyDelivery };

      const result = await maybeHandleResetCommand(params);

      expect(onObservedReplyDelivery).not.toHaveBeenCalled();
      expect(result).toEqual({
        shouldContinue: false,
        reply: { text: "✅ New session started.", isStatusNotice: true },
      });
    },
  );

  it("prefers the target session entry when emitting reset hooks", async () => {
    const params = buildResetParams("/reset");
    params.sessionEntry = {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
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
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "sessions.json");
    const params = buildResetParams("/reset soft");
    const sessionEntry = {
      ...cliSession("session-1", 0, "cli-session-1", "prompt-hash"),
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
    expect(params.command.resetHookTriggered).toBe(true);
    expect(params.command.softResetTriggered).toBe(true);
    expect(params.command.softResetTail).toBe("");
    expectCliSessionCleared(params.sessionEntry);
    expect(
      loadSessionEntry({ sessionKey: params.sessionKey, storePath })?.updatedAt,
    ).toBeGreaterThan(0);
    expect(clearBootstrapSnapshotSpy).toHaveBeenCalledWith("agent:main:main");
  });

  it.each<{
    name: string;
    provider: string | undefined;
    surface?: string;
    scopes?: string[];
    allowed: boolean;
    body?: string;
    source?: "text" | "native";
    originatingChannel?: string;
    commandAuthorized?: boolean;
    silent?: boolean;
  }>([
    { name: "write scope", provider: "webchat", scopes: ["operator.write"], allowed: false },
    { name: "admin scope", provider: "webchat", scopes: ["operator.admin"], allowed: true },
    { name: "legacy empty scopes", provider: "webchat", scopes: [], allowed: true },
    {
      name: "internal Provider remains authoritative",
      provider: "webchat",
      surface: "telegram",
      scopes: ["operator.write"],
      allowed: false,
    },
    {
      name: "external Provider remains authoritative",
      provider: "telegram",
      scopes: ["operator.write"],
      allowed: true,
    },
    {
      name: "missing Provider uses internal Surface",
      provider: undefined,
      scopes: ["operator.write"],
      allowed: false,
    },
    {
      name: "text /new Create a note forwarded from Gateway to external origin",
      provider: "webchat",
      body: "/new Create a note",
      originatingChannel: "telegram",
      scopes: ["operator.write"],
      allowed: false,
      silent: true,
    },
    {
      name: "text /new Create a note from external Provider with internal Surface and origin",
      body: "/new Create a note",
      provider: "telegram",
      originatingChannel: "webchat",
      commandAuthorized: false,
      allowed: false,
      silent: true,
    },
  ])(
    "preserves reset authorization and denial routing: $name",
    async ({
      provider,
      surface = "webchat",
      scopes,
      allowed,
      body = "/reset soft",
      source = "text",
      originatingChannel,
      commandAuthorized = true,
      silent = false,
    }) => {
      const params = buildResetParams(
        body,
        {
          commands: { text: true },
        } as OpenClawConfig,
        {
          Provider: provider,
          Surface: surface,
          OriginatingChannel: originatingChannel,
          OriginatingTo: originatingChannel ? "chat:reset-test" : undefined,
          ExplicitDeliverRoute: originatingChannel !== undefined,
          CommandSource: source,
          CommandAuthorized: commandAuthorized,
          GatewayClientScopes: scopes,
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
      expect(params.sessionEntry.sessionId).toBe(before.sessionId);
      expect(params.sessionEntry.lifecycleRevision).toBe(before.lifecycleRevision);
      expect(params.command.softResetTriggered === true).toBe(allowed);
      expect(triggerInternalHookMock).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(clearBootstrapSnapshotSpy).toHaveBeenCalledTimes(allowed ? 1 : 0);
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
    params.sessionEntry = cliSession(
      "session-direct",
      1,
      "cli-session-direct",
      "prompt-hash-direct",
    );
    params.sessionStore = {
      [params.sessionKey]: cliSession("session-store", 2, "cli-session-store", "prompt-hash-store"),
    };

    const result = await maybeHandleResetCommand(params);

    expect(result).toBeNull();
    expectCliSessionCleared(params.sessionEntry);
    expectCliSessionCleared(params.sessionStore?.[params.sessionKey]);
  });

  it("rejects soft reset for bound ACP sessions", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockResolvedValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildAcpResetParams("/reset soft");

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /reset soft is not available for ACP-bound sessions yet." },
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(resetMocks.resetConfiguredBindingTargetInPlace).not.toHaveBeenCalled();
  });
});
