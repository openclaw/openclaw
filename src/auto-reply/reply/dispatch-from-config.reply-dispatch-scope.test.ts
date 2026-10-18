import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { ReplyDispatchRun } from "../get-reply-options.types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  sessionBindingMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { expectCalls } from "./reply-contract.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

const handledReply = { handled: true, queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
function discordCtx(SessionKey: string, overrides: Parameters<typeof buildTestCtx>[0] = {}) {
  return buildTestCtx({
    Body: "hello",
    BodyForAgent: "hello",
    SessionKey,
    Provider: "discord",
    Surface: "discord",
    To: "C1",
    AccountId: "default",
    ...overrides,
  });
}

describe("dispatchReplyFromConfig reply hook scope", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    const readEntry = (...args: unknown[]) => {
      const { sessionKey } = args[0] as { sessionKey: string };
      return sessionStoreMocks.entriesBySessionKey.get(sessionKey);
    };
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
  });

  it.each([
    ["local command target from ACP source", false, false],
    ["bound ACP reset tail", true, false],
    ["prepared bound ACP reset tail", true, true],
  ] as const)("scopes reply hooks to the prepared %s", async (_name, bound, prepared) => {
    const sourceKey = bound ? "agent:test:discord:channel:C1" : "agent:test:acp:source";
    const targetKey = bound ? "agent:test:acp:bound" : "agent:test:target";
    const runId = "dispatched-run";
    const onAgentRunStart = vi.fn(() => "reply-dispatch");
    const onPreparedAgentRunStart = vi.fn(() => "reply-dispatch");
    const dispatchRun: ReplyDispatchRun = {
      completionSource: "reply-dispatch",
      getResult: () => ({}),
    };
    const preparedStart = { runId, options: dispatchRun, transcriptStart: null };
    const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: "source user turn" },
      target: () => undefined,
    });
    const sourceEntry = { sessionId: "source-session", updatedAt: Date.now() };
    const targetEntry = { sessionId: "target-session", updatedAt: Date.now() };
    sessionStoreMocks.entriesBySessionKey.set(sourceKey, sourceEntry);
    sessionStoreMocks.entriesBySessionKey.set(targetKey, targetEntry);
    if (bound) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "bound-dispatch-kind",
        targetSessionKey: targetKey,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
      });
    }
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName, scope) => hookName === "reply_dispatch" && scope?.dispatchKind !== "agent",
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventValue, contextValue) => {
      expect(eventValue).toMatchObject({ sessionKey: targetKey });
      expect(contextValue).toMatchObject({ dispatchKind: "acp" });
      const event = eventValue as { isTailDispatch?: boolean };
      if (event.isTailDispatch) {
        const context = contextValue as PluginHookReplyDispatchContext;
        expect(
          prepared
            ? context.onPreparedAgentRunStart?.(preparedStart)
            : context.onAgentRunStart?.(runId, undefined, dispatchRun),
        ).toBe("reply-dispatch");
        context.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.("accepted user turn");
      }
      return event.isTailDispatch ? handledReply : undefined;
    });
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options) => {
      if (bound) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      expect(options?.onAgentRunStart?.(runId, undefined, dispatchRun)).toBe("reply-dispatch");
      return { text: "local reply" };
    });
    const ctx = discordCtx(
      sourceKey,
      !bound ? { CommandSource: "native", CommandTargetSessionKey: targetKey } : {},
    );
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
      replyOptions: {
        ...(prepared ? { onPreparedAgentRunStart } : { onAgentRunStart }),
        userTurnTranscriptRecorder,
      },
    });
    expect(result.queuedFinal).toBe(true);
    expect(hookMocks.runner.hasHooks).toHaveBeenCalledWith("reply_dispatch", {
      dispatchKind: bound ? "acp" : "agent",
    });
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(bound ? 2 : 0);
    expect(replyResolver).toHaveBeenCalledTimes(1);
    if (prepared) {
      expectCalls([onPreparedAgentRunStart, [[preparedStart]]], [onAgentRunStart, []]);
    } else {
      expectCalls([onAgentRunStart, [[runId, undefined, dispatchRun]]]);
    }
    expect(userTurnTranscriptRecorder.message?.content).toBe(
      bound ? "accepted user turn" : "source user turn",
    );
  });

  it("refuses restricted ACP takeover before invoking reply hooks", async () => {
    const sessionKey = "agent:test:restricted-acp";
    const entry = {
      sessionId: "restricted-acp-session",
      updatedAt: Date.now(),
      acp: { backend: "acpx" },
    };
    sessionStoreMocks.entriesBySessionKey.set(sessionKey, entry);
    sessionStoreMocks.loadSessionStoreEntry.mockReturnValue(entry);
    sessionStoreMocks.loadSessionEntry.mockReturnValue(entry);
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runReplyDispatch.mockResolvedValue(handledReply);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn<InternalGetReplyFromConfig>();
    const guarded = { permissionMode: "guarded" as const, toolOverrides: { webSearch: false } };

    const result = await dispatchReplyFromConfig({
      ctx: discordCtx(sessionKey),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { admittedSessionSettings: guarded },
    });

    expect(hookMocks.runner.runReplyDispatch).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("cannot enforce its permission or tool policy"),
      }),
    );
    expect(result.queuedFinal).toBe(true);
  });
});
