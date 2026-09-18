import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHookReplyDispatchContext } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { ReplyDispatchRun } from "../get-reply-options.types.js";
import {
  acpMocks,
  createDispatcher,
  createHookCtx,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  resetReplyDispatchOutcomeMock,
  sessionBindingMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig reply hook scope", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
    resetReplyDispatchOutcomeMock();
  });

  it.each([false, true])("keeps ACP command resolution and reset tail=%s", async (tail) => {
    hookMocks.runner.hasHooks.mockImplementation((name) => name === "reply_dispatch");
    let dispatchCount = 0;
    hookMocks.runner.runReplyDispatchOutcome.mockImplementation(async () => {
      dispatchCount += 1;
      return tail && dispatchCount === 2
        ? { status: "error", error: "ACP reset tail failed" }
        : { status: "declined" };
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (ctx) => {
      if (tail) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      return { text: "ACP status" };
    });
    const command = tail ? "/new continue the task" : "/acp status";
    await dispatchReplyFromConfig({
      ctx: {
        ...createHookCtx(),
        SessionKey: "agent:test:acp:command",
        Body: command,
        BodyForAgent: command,
        BodyForCommands: command,
        commandText: command,
      },
      cfg: { diagnostics: { enabled: true } },
      dispatcher,
      replyResolver,
    });
    expect(replyResolver).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      tail ? expect.objectContaining({ isError: true }) : { text: "ACP status" },
    );
    expect(hookMocks.runner.runReplyDispatchOutcome).toHaveBeenCalledTimes(tail ? 2 : 1);
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledOnce();
    expect(
      diagnosticMocks.logSessionStateChange.mock.calls.filter(([event]) => event.state === "idle"),
    ).toHaveLength(1);
  });

  it("keeps an ACP failure notice silent when the child is parent-owned", async () => {
    const sessionKey = "agent:test:acp:background-child";
    const entry = { sessionId: "background-child", spawnedBy: "agent:test:parent" };
    hookMocks.runner.runReplyDispatchOutcome.mockResolvedValue({
      status: "error",
      error: "ACP failed after starting work",
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "ordinary fallback" }));

    await acpMocks.readAcpSessionEntry.withImplementation(
      () => ({
        agentId: "test",
        sessionKey,
        entry,
        acp: {
          backend: "acpx",
          agent: "fixture",
          runtimeSessionName: "background-child",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      }),
      async () => {
        await dispatchReplyFromConfig({
          ctx: { ...createHookCtx(), SessionKey: sessionKey },
          cfg: emptyConfig,
          dispatcher,
          replyResolver,
        });
      },
    );

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", reason: "acp_dispatch_unclaimed" }),
    );
  });

  it.each<{
    name: string;
    targetKey: string;
    expectedKind: "agent" | "acp";
    sourceKey?: string;
    metadata?: boolean;
    missing?: boolean;
    bound?: boolean;
    tail?: boolean;
  }>([
    { name: "local session", targetKey: "agent:test:session", expectedKind: "agent" },
    { name: "new session", targetKey: "agent:test:session", missing: true, expectedKind: "agent" },
    {
      name: "stale ACP key",
      targetKey: "agent:test:acp:missing",
      missing: true,
      expectedKind: "acp",
    },
    {
      name: "stored ACP session",
      targetKey: "agent:test:session",
      metadata: true,
      expectedKind: "acp",
    },
    {
      name: "ACP command target",
      sourceKey: "agent:test:source",
      targetKey: "agent:test:target",
      metadata: true,
      expectedKind: "acp",
    },
    {
      name: "local command target from ACP source",
      sourceKey: "agent:test:acp:source",
      targetKey: "agent:test:target",
      expectedKind: "agent",
    },
    {
      name: "bound ACP reset tail",
      sourceKey: "agent:test:discord:channel:C1",
      targetKey: "agent:test:acp:bound",
      bound: true,
      tail: true,
      expectedKind: "acp",
    },
  ])("scopes reply hooks to the prepared $name", async (scenario) => {
    const onAgentRunStart = vi.fn(() => "reply-dispatch");
    const dispatchRun: ReplyDispatchRun = {
      completionSource: "reply-dispatch",
      getResult: () => ({}),
    };
    const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: { text: "source user turn" },
      target: () => undefined,
    });
    const sourceKey = scenario.sourceKey ?? scenario.targetKey;
    const sourceEntry = { sessionId: "source-session", updatedAt: Date.now() };
    const targetEntry = scenario.missing
      ? undefined
      : {
          sessionId: "target-session",
          updatedAt: Date.now(),
          ...(scenario.metadata ? { acp: { backend: "acpx" } } : {}),
        };
    if (sourceKey !== scenario.targetKey) {
      sessionStoreMocks.entriesBySessionKey.set(sourceKey, sourceEntry);
    }
    if (targetEntry) {
      sessionStoreMocks.entriesBySessionKey.set(scenario.targetKey, targetEntry);
    }
    const readEntry = (...args: unknown[]) => {
      const { sessionKey } = args[0] as { sessionKey: string };
      return sessionStoreMocks.entriesBySessionKey.get(sessionKey);
    };
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
    if (scenario.bound) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "bound-dispatch-kind",
        targetSessionKey: scenario.targetKey,
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
      expect(eventValue).toMatchObject({ sessionKey: scenario.targetKey });
      expect(contextValue).toMatchObject({ dispatchKind: "acp" });
      const event = eventValue as { isTailDispatch?: boolean };
      if (!scenario.tail || event.isTailDispatch) {
        const context = contextValue as PluginHookReplyDispatchContext;
        expect(context.onAgentRunStart?.("dispatched-run", undefined, dispatchRun)).toBe(
          "reply-dispatch",
        );
        context.userTurnTranscriptRecorder?.replaceTextBeforePersistence?.("accepted user turn");
      }
      return scenario.tail && !event.isTailDispatch
        ? undefined
        : {
            handled: true,
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
          };
    });
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (ctx, options) => {
      if (scenario.tail) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      expect(options?.onAgentRunStart?.("dispatched-run", undefined, dispatchRun)).toBe(
        "reply-dispatch",
      );
      return { text: "local reply" };
    });
    const ctx = buildTestCtx({
      Body: "hello",
      BodyForAgent: "hello",
      ...(scenario.tail ? { CommandBody: "/new continue" } : {}),
      SessionKey: sourceKey,
      Provider: "discord",
      Surface: "discord",
      To: "C1",
      AccountId: "default",
      ...(scenario.sourceKey && !scenario.bound
        ? { CommandSource: "native", CommandTargetSessionKey: scenario.targetKey }
        : {}),
    });
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
      replyOptions: { onAgentRunStart, userTurnTranscriptRecorder },
    });
    expect(result.queuedFinal).toBe(true);
    expect(hookMocks.runner.hasHooks).toHaveBeenCalledWith("reply_dispatch", {
      dispatchKind: scenario.expectedKind,
    });
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" ? 0 : scenario.tail ? 2 : 1,
    );
    expect(replyResolver).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" || scenario.tail ? 1 : 0,
    );
    expect(onAgentRunStart).toHaveBeenCalledExactlyOnceWith(
      "dispatched-run",
      undefined,
      dispatchRun,
    );
    expect(userTurnTranscriptRecorder.message?.content).toBe(
      scenario.expectedKind === "acp" ? "accepted user turn" : "source user turn",
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
    const readEntry = () => entry;
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runReplyDispatch.mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn<InternalGetReplyFromConfig>();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "hello",
        BodyForAgent: "hello",
        SessionKey: sessionKey,
        Provider: "discord",
        Surface: "discord",
        To: "C1",
        AccountId: "default",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        admittedSessionSettings: {
          permissionMode: "guarded",
          toolOverrides: { webSearch: false },
        },
      },
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
