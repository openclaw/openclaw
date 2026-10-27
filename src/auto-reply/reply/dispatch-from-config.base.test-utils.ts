// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createMissingReplyNotice, resolveReplyCompletion } from "../../agents/reply-completion.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  isSessionControllerWorkActive,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { settleReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import { registerOriginRoutingCases } from "./dispatch-from-config.origin-routing.cases.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  messageAuditMocks,
  mocks,
  mockSessionStorePath,
  runtimePluginMocks,
  sessionStoreMocks,
  transcriptMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import * as dispatchHarness from "./dispatch-from-config.test-support.js";
import {
  automaticGroupReplyConfig,
  automaticDirectReplyConfig,
  dispatchReplyFromConfig,
  createReplyOperation,
  setNoAbort,
  firstMockCall,
  firstMockArg,
  firstFinalReplyPayload,
  installThreadingTestPlugin,
  requireBlockReplyHandler,
  messageAuditEvents,
} from "./dispatch-from-config.test-support.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";
import { buildTestCtx } from "./test-ctx.js";

function createSlackChannelCtx(fields: Partial<MsgContext>) {
  return buildTestCtx({
    Provider: "slack",
    Surface: "slack",
    OriginatingChannel: "slack",
    OriginatingTo: "channel:C123",
    ...fields,
  });
}

beforeAll(dispatchHarness.globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(dispatchHarness.describe0BeforeEach0);
  registerOriginRoutingCases();

  it.each([false, true])(
    "reports agent refusal before runtime loading (aborted: %s)",
    async (aborted) => {
      const refusal = {
        agentId: "cleaner",
        paths: ["/synthetic/agents/cleaner/openclaw-agent.cleaner.sqlite"],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch" as const,
        reason: "Refused agent cleaner: its database belongs to main.",
        repairHint: "Keep the main copy and quarantine the divergent cleaner copy, then restart.",
      };
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, cleaner: {} } } };
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async () => ({ text: "must not run" }));
      const abort = new AbortController();
      if (aborted) {
        abort.abort();
      }
      recordAgentDatabaseAdmissions([refusal]);
      try {
        const result = await dispatchReplyFromConfig({
          ctx: buildTestCtx({ AgentId: "cleaner", SessionKey: "agent:cleaner:main" }),
          cfg,
          dispatcher,
          replyResolver,
          replyOptions: { abortSignal: abort.signal },
        });
        expect(result.queuedFinal).toBe(!aborted);
        if (aborted) {
          expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        } else {
          expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
            text: `${refusal.reason}\n${refusal.repairHint}`,
            isError: true,
          });
        }
        expect(replyResolver).not.toHaveBeenCalled();
        expect(runtimePluginMocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
      } finally {
        recordAgentDatabaseAdmissions([]);
      }
    },
  );

  async function createActiveSlackThread(userId: string) {
    setNoAbort();
    const sessionKey = `agent:main:slack:direct:${userId}`;
    const sessionId = "active-session";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath: mockSessionStorePath,
      kind: "visible",
      resetTriggered: false,
      routeThreadId: "500.000",
    });
    if (admission.status !== "owned") {
      throw new Error("expected active Slack owner admission");
    }
    const activeOperation = admission.operation;
    activeOperation.setPhase("running");
    return {
      activeOperation,
      sessionId,
      sessionKey,
      createCtx: (overrides: Partial<MsgContext> = {}) =>
        buildTestCtx({
          Provider: "slack",
          Surface: "slack",
          OriginatingChannel: "slack",
          OriginatingTo: `user:${userId}`,
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageThreadId: "501.000",
          ...overrides,
        }),
    };
  }

  it("falls back to a live registry handle when the Gateway dispatch runtime is inactive", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      SessionKey: "agent:main:main",
    });

    const replyResolver = vi.fn(
      async (
        _ctx: MsgContext,
        _opts?: GetReplyOptions,
        _cfg?: OpenClawConfig,
        _preparedRuntime?: unknown,
      ) => ({ text: "hi" }) satisfies ReplyPayload,
    );
    const preparedRuntime = await import("../../agents/prepared-model-runtime.js");
    const preparedLookup = vi
      .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
      .mockResolvedValue(undefined);
    try {
      await dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher,
        replyResolver,
      });
    } finally {
      preparedLookup.mockRestore();
    }

    const pluginLoadOptions = firstMockArg(
      runtimePluginMocks.loadAgentRuntimePluginRegistryHandle,
      "runtime plugin load",
    ) as { config?: unknown; workspaceDir?: unknown };
    expect(pluginLoadOptions.config).toBe(cfg);
    expect(typeof pluginLoadOptions.workspaceDir).toBe("string");
    expect(
      runtimePluginMocks.loadAgentRuntimePluginRegistryHandle.mock.invocationCallOrder[0],
    ).toBeLessThan(
      expectDefined(
        hookMocks.runner.hasHooks.mock.invocationCallOrder[0],
        "hookMocks.runner.hasHooks.mock.invocationCallOrder[0] test invariant",
      ),
    );
    expect(replyResolver.mock.calls[0]?.[3]).toBeUndefined();
  });

  it("drops a durable source duplicate before before_dispatch hooks", async () => {
    setNoAbort();
    const sessionKey = "agent:main:discord:direct:123";
    const sourceTurnId = expectDefined(
      buildChannelSourceTurnId({
        provider: "discord",
        conversationId: "channel:123",
        messageId: "message-1",
      }),
      "source turn id",
    );
    sessionStoreMocks.currentEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
    };
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "before_dispatch") as () => boolean,
    );
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: sessionKey,
      OriginatingTo: "channel:123",
      MessageSid: "message-1",
      MessageSidFull: "   ",
    });
    const replyResolver = vi.fn(async () => ({ text: "must not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(result).toMatchObject({ queuedFinal: false });
    expect(hookMocks.runner.runBeforeDispatch).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("returns session metadata changes marked during reply resolution", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        SessionKey: sessionKey,
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (ctx) => {
        markCommandSessionMetadataChanged({ ctx, sessionKey, agentId: "main" });
        return { text: "goal updated" };
      },
    });

    expect(result.sessionMetadataChanges).toEqual([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
  });

  it("notifies session metadata changes before later dispatch errors", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const dispatcher = createDispatcher();
    dispatcher.sendFinalReply = vi.fn(() => {
      throw new Error("delivery failed");
    });
    const onSessionMetadataChanges = vi.fn();

    await expect(
      dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          SessionKey: sessionKey,
        }),
        cfg: emptyConfig,
        dispatcher,
        onSessionMetadataChanges,
        replyResolver: async (ctx) => {
          markCommandSessionMetadataChanged({ ctx, sessionKey, agentId: "main" });
          return { text: "goal updated" };
        },
      }),
    ).rejects.toThrow("delivery failed");

    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
  });

  it("skips pre-dispatch admission when the caller already aborted", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:group:-1003774691294:topic:3731";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    abortController.abort();

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: sessionKey,
        ChatType: "group",
        IsForum: true,
        MessageSid: "27784",
        MessageThreadId: 3731,
        TransportThreadId: 3731,
        To: "telegram:-1003774691294:topic:3731",
        BodyForAgent: "superseded while waiting",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });

    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "blocked",
        outcome: "skipped",
        reasonCode: "reply_operation_aborted",
      }),
    );
    activeOperation.complete();
  });

  it.each([
    ["confirmed", false, "succeeded", "completed", "active_run_injected"],
    ["unconfirmed", true, "blocked", "skipped", "reply_operation_aborted"],
  ])(
    "audits %s shared steering finalization with the Gateway terminal",
    async (_name, aborted, status, outcome, reasonCode) => {
      setNoAbort();
      const dispatcher = createDispatcher();
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
        const runState = resolveReplyOperationRunState(opts);
        if (!runState) {
          throw new Error("expected reply operation run state");
        }
        runState.admission = { status: "accepted", mode: "steer" };
        runState.messageInjectionAborted = aborted ? true : undefined;
        return undefined;
      });

      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: "agent:main:telegram:direct:steer-audit",
        }),
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyResolver,
      });
      expect(result.deferredToActiveRun).toBe("steer");
      expect(messageAuditEvents()).toContainEqual(
        expect.objectContaining({ status, outcome, reasonCode }),
      );
    },
  );

  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack", defaultAccountId: "work" });
    const cfg = automaticDirectReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: undefined,
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    const replyDispatchCall = firstMockCall(
      hookMocks.runner.runReplyDispatch,
      "reply dispatch",
    ) as [PluginHookReplyDispatchEvent, unknown];
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(false);
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
  });

  it("mirrors ownerless same-channel Slack finals after successful delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "slack" });
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    const ctx = createSlackChannelCtx({
      ChatType: "group",
      SessionKey: "agent:main:slack:channel:C123",
      MessageSid: "slack-message-1",
    });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { runId: "slack-run-1" },
      replyResolver: async () => ({ text: "Slack command reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      agentId: "main",
      expectedWriterRunId: "slack-run-1",
      text: "Slack command reply",
      mediaUrls: undefined,
      idempotencyKey: "channel-final:slack-message-1:0",
      deliveryMirror: {
        kind: "channel-final",
        sourceMessageId: "slack-message-1",
      },
      storePath: mockSessionStorePath,
      updateMode: "inline",
      config: emptyConfig,
      beforeMessageWrite: expect.any(Function),
    });
  });

  it.each([
    ["telegram", "command-account", "command-chat"],
    ["telegram", "other-account", "command-chat"],
    ["telegram", "command-account", "other-chat"],
    ["discord", "command-account", "command-chat"],
    ["slack", "command-account", "command-chat"],
  ] as const)(
    "records a delivered %s command exchange for account %s and conversation %s",
    async (channel, accountId, conversationId) => {
      setNoAbort();
      const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
      dispatcher.appendBeforeDeliver?.((payload) => ({
        ...payload,
        text: "Thinking level set to low.",
      }));
      transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Body: "/think low",
          BodyForCommands: "/think low",
          Provider: channel,
          Surface: channel,
          OriginatingChannel: channel,
          SessionKey: "agent:main:main",
          MessageSid: "command-message",
          AccountId: accountId,
          OriginatingTo: conversationId,
          From: conversationId,
          To: conversationId,
        }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver: async () => ({ text: "Before delivery transform" }),
      });
      await settleReplyDispatcher({ dispatcher });
      expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Thinking level set to low.",
          command: {
            text: "/think low",
            idempotencyKey: `command-input:["${channel}","${accountId}","${conversationId}","command-message"]`,
          },
        }),
      );
    },
  );

  it("records the stop command next to the delivered fast-abort notice", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: true, aborted: true });
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: "/stop",
        BodyForCommands: "/stop",
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        SessionKey: "agent:main:main",
        MessageSid: "stop-message",
        AccountId: "stop-account",
        OriginatingTo: "stop-chat",
        From: "stop-chat",
        To: "stop-chat",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: vi.fn(),
    });
    await settleReplyDispatcher({ dispatcher });
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "⚙️ Agent was aborted.",
        command: {
          text: "/stop",
          idempotencyKey: 'command-input:["telegram","stop-account","stop-chat","stop-message"]',
        },
      }),
    );
  });

  it("mirrors reset acknowledgements into the canonically prepared Slack session", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    const sessionKey = "Agent:Main:Slack:Channel:C123";
    const preparedSessionKey = "agent:main:slack:channel:c123";
    sessionStoreMocks.currentEntry = {
      sessionId: "previous-session",
      updatedAt: Date.now(),
    };
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: "slack-reset-message",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        (
          opts as GetReplyOptions & {
            onSessionPrepared?: (binding: {
              sessionKey?: string;
              sessionId: string;
              storePath?: string;
            }) => void;
          }
        ).onSessionPrepared?.({
          sessionKey: preparedSessionKey,
          sessionId: "new-session",
          storePath: "/tmp/rotated-sessions.json",
        });
        return { text: "✅ New session started.", isStatusNotice: true };
      },
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        expectedSessionId: "new-session",
        storePath: "/tmp/rotated-sessions.json",
        text: "✅ New session started.",
      }),
    );
  });

  it.each([
    [
      "embedded",
      () =>
        setReplyPayloadMetadata({ text: "Persisted runtime reply" }, { assistantMessageIndex: 7 }),
    ],
    [
      "runtime-owned",
      () =>
        setReplyPayloadMetadata(
          { text: "Persisted runtime reply" },
          { assistantTranscriptOwned: true },
        ),
    ],
    ["missing-answer notice", createMissingReplyNotice],
  ])("does not mirror %s finals with a runtime transcript owner", async (_name, payload) => {
    setNoAbort();
    const dispatcher = createDispatcher();
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    const result = await dispatchReplyFromConfig({
      ctx: createSlackChannelCtx({ SessionKey: "agent:main:slack:channel:C123" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => payload(),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(result.queuedFinal).toBe(true);
    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("disables routed delivery mirrors for CLI-owned finals", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    mocks.routeReply.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    installThreadingTestPlugin({ id: "telegram", defaultAccountId: "default" });

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
        AccountId: "default",
        SessionKey: "agent:main:telegram:group:999",
      }),
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver: async () =>
        setReplyPayloadMetadata(
          { text: "Persisted routed CLI reply" },
          { assistantTranscriptOwned: true },
        ),
    });

    expect(result.queuedFinal).toBe(true);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Persisted routed CLI reply" },
        mirror: false,
      }),
    );
  });

  it("uses accepted steered inbound audio for final TTS", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      SessionKey: "agent:main:whatsapp:direct:chat-1",
      BodyForAgent: "text turn",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as
          | {
              replyOperation?: ReturnType<typeof createReplyOperation>;
            }
          | undefined
      )?.replyOperation;
      expect(operation?.acceptedSteeredInboundAudio).toBe(false);
      operation?.markSteeredInputAccepted({ inboundAudio: true });
      return { text: "reply to steered audio" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher,
      replyResolver,
    });

    const finalTtsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls.find(
      ([params]) => (params as { kind?: string }).kind === "final",
    )?.[0] as { inboundAudio?: boolean } | undefined;
    expect(finalTtsCall?.inboundAudio).toBe(true);
    expect(firstFinalReplyPayload(dispatcher)?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("passes reply policy to routed block delivery", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    const slackPlugin = createChannelTestPluginBase({ id: "slack" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...slackPlugin,
            config: {
              ...slackPlugin.config,
              listAccountIds: () => ["work"],
              defaultAccountId: () => "work",
            },
            threading: {
              resolveReplyToMode: ({ accountId }: { accountId?: string | null }) =>
                accountId === "work" ? "off" : "all",
            },
          },
        },
      ]),
    );
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
      ChatType: "channel",
      SessionKey: "agent:main:slack:channel:C123",
    });
    const cfg = {} as OpenClawConfig;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({
        text: "partial",
        replyToId: "999.000",
        replyToTag: true,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        channel: "slack",
        replyKind: "block",
        replyDelivery: {
          chatType: "channel",
          replyToMode: "off",
        },
      }),
    );
  });

  it("mirrors the delivered ownerless Slack text after dispatcher hook rewrites", async () => {
    setNoAbort();
    const dispatcher = createReplyDispatcher({ deliver: vi.fn() });
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final" ? { ...payload, text: "Redacted Slack reply" } : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: createSlackChannelCtx({
        SessionKey: "agent:main:slack:channel:C123",
        MessageSid: "slack-message-2",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Secret Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Redacted Slack reply",
        idempotencyKey: "channel-final:slack-message-2:0",
      }),
    );
  });

  it("does not mirror ownerless Slack finals removed by dispatcher hooks", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    dispatcher.appendBeforeDeliver?.((payload, info) =>
      info.kind === "final"
        ? { ...payload, text: "", mediaUrl: undefined, mediaUrls: undefined }
        : payload,
    );
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();

    await dispatchReplyFromConfig({
      ctx: createSlackChannelCtx({ SessionKey: "agent:main:slack:channel:C123" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "Hidden Slack reply" }),
    });
    await settleReplyDispatcher({ dispatcher });

    expect(transcriptMocks.appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
  });

  it("records routed Slack thread id on dispatch-owned reply operations", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "user:U1",
      ChatType: "direct",
      SessionKey: "agent:main:slack:direct:U1",
      MessageThreadId: "501.000",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const operation = (
        opts as { replyOperation?: { routeThreadId?: string | number } } | undefined
      )?.replyOperation;
      expect(operation?.routeThreadId).toBe("501.000");
      return { text: "hi" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("lets a different Slack DM routed thread reach reply resolution while another thread is active", async () => {
    const { activeOperation, createCtx, sessionId, sessionKey } =
      await createActiveSlackThread("U1");
    const dispatcher = createDispatcher();
    let inBandMutationRan = false;
    const rotatedSessionId = "rotated-session";
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(isSessionControllerWorkActive(mockSessionStorePath, [sessionKey, sessionId])).toBe(
        true,
      );
      await runSessionMutation({
        scope: mockSessionStorePath,
        identities: [sessionKey, sessionId],
        run: async () => {
          inBandMutationRan = true;
          sessionStoreMocks.currentEntry = {
            sessionId: rotatedSessionId,
            updatedAt: Date.now(),
          };
          (
            opts as
              | (GetReplyOptions & {
                  onSessionPrepared?: (binding: {
                    sessionKey: string;
                    sessionId: string;
                    storePath: string;
                  }) => void;
                })
              | undefined
          )?.onSessionPrepared?.({
            sessionKey,
            sessionId: rotatedSessionId,
            storePath: mockSessionStorePath,
          });
        },
      });
      return { text: "thread B reply" } satisfies ReplyPayload;
    });

    try {
      const resultPromise = dispatchReplyFromConfig({
        ctx: createCtx({ BodyForAgent: "second top-level DM" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
      });

      const result = await Promise.race([
        resultPromise,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => resolve("timed-out"), 1_000);
        }),
      ]);
      if (result === "timed-out") {
        activeOperation.complete();
        await resultPromise;
        throw new Error("Slack routed thread was blocked by the active reply operation");
      }

      expect(result).toMatchObject({
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(inBandMutationRan).toBe(true);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    } finally {
      activeOperation.complete();
    }
  });

  it("holds a Slack bypass lease until an abort-insensitive resolver settles", async () => {
    const { activeOperation, createCtx, sessionId, sessionKey } =
      await createActiveSlackThread("U3");
    const { promise: resolverGate, resolve: releaseResolver } = createDeferred();
    const { promise: resolverEntered, resolve: signalResolverEntered } = createDeferred();
    let signalResolverAborted: () => void = () => {};
    const resolverAborted = new Promise<void>((resolve) => {
      signalResolverAborted = resolve;
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const signal = opts?.abortSignal;
      if (!signal) {
        throw new Error("expected resolver abort signal");
      }
      if (signal.aborted) {
        signalResolverAborted();
      } else {
        signal.addEventListener("abort", signalResolverAborted, { once: true });
      }
      signalResolverEntered();
      await resolverGate;
      await requireBlockReplyHandler(opts?.onBlockReply)({ text: "stale late block" });
      return { text: "late reply" } satisfies ReplyPayload;
    });
    const dispatcher = createDispatcher();
    const dispatch = dispatchReplyFromConfig({
      ctx: createCtx({ BodyForAgent: "abort-insensitive routed thread" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    await resolverEntered;
    activeOperation.complete();

    let mutationRan = false;
    const externalLifecycleRequest = new AsyncResource("slack-bypass-settle-race");
    const mutation = externalLifecycleRequest.runInAsyncScope(
      async () =>
        await runSessionMutation({
          scope: mockSessionStorePath,
          identities: [sessionKey, sessionId],
          kind: "reset",
          policy: "preempt",
          preempt: { activeRun: "abort", waitingInputs: "cancel" },
          run: async () => {
            mutationRan = true;
          },
        }),
    );
    expect(mutationRan).toBe(false);
    expect(isSessionControllerWorkActive(mockSessionStorePath, [sessionKey, sessionId])).toBe(true);

    await resolverAborted;
    releaseResolver();
    const result = await dispatch;
    await mutation;

    expect(result.queuedFinal).toBe(false);
    expect(mutationRan).toBe(true);
    expect(isSessionControllerWorkActive(mockSessionStorePath, [sessionKey, sessionId])).toBe(
      false,
    );
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    externalLifecycleRequest.emitDestroy();
  });

  it("bounds Slack bypass lease cleanup when dispatcher idle never settles", async ({ signal }) => {
    const { activeOperation, createCtx, sessionId, sessionKey } =
      await createActiveSlackThread("U4");
    const dispatcher = createDispatcher();
    const settlementEntered = Promise.withResolvers<void>();
    let finalizing = false;
    const replyResolver = vi.fn(async () => {
      // Admission uses its real scheduler; this test controls only final settlement.
      vi.useFakeTimers();
      finalizing = true;
      return undefined;
    });
    dispatcher.waitForIdle = vi.fn(async () => {
      if (finalizing) {
        settlementEntered.resolve();
        await new Promise<void>(() => {});
      }
    });
    dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy = () => ({
      maxTimeoutMs: 25,
      shouldExtend: () => false,
    });

    try {
      const dispatch = dispatchReplyFromConfig({
        ctx: createCtx({ BodyForAgent: "hung delivery barrier" }),
        cfg: emptyConfig,
        dispatcher,
        replyResolver,
        replyOptions: { abortSignal: signal },
      });
      await withinTest(
        awaitGateBeforeSettlement(
          settlementEntered.promise,
          dispatch,
          "Slack bypass dispatch settled before its post-resolver idle wait",
        ),
        signal,
      );
      expect(replyResolver).toHaveBeenCalledOnce();
      // The post-resolver admission handoff settles before the no-reply deadline starts.
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await withinTest(dispatch, signal);

      // An unsettled custom dispatcher has no receipt, so the turn cannot claim delivery.
      expect(result.queuedFinal).toBe(false);
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
      activeOperation.complete();
      await vi.waitFor(
        () => {
          expect(isSessionControllerWorkActive(mockSessionStorePath, [sessionKey, sessionId])).toBe(
            false,
          );
        },
        { timeout: 500 },
      );
    } finally {
      activeOperation.complete();
      vi.useRealTimers();
    }
  });

  it("lets low-level channel turns reach queue resolution while a reply operation is active", async () => {
    setNoAbort();
    const { createRuntimeChannel } = await import("../../plugins/runtime/runtime-channel.js");
    const lowLevelDispatch = createRuntimeChannel().reply.dispatchReplyFromConfig;
    const sessionKey = "agent:main:dingtalk-connector:direct:1";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => {
      activeOperation.abortByUser();
      activeOperation.complete();
      return { text: "newest reply" } satisfies ReplyPayload;
    });
    const resultPromise = lowLevelDispatch({
      ctx: buildTestCtx({
        Provider: "dingtalk-connector",
        Surface: "dingtalk-connector",
        SessionKey: sessionKey,
        BodyForAgent: "interrupt this active turn",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    try {
      await vi.waitFor(() => expect(replyResolver).toHaveBeenCalledOnce());
      await expect(resultPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "newest reply" });
    } finally {
      if (!activeOperation.result) {
        activeOperation.complete();
      }
      await Promise.allSettled([resultPromise]);
    }
  });

  it("lets Gateway-owned turns reach queue resolution while a reply operation is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const runState = expectDefined(resolveReplyOperationRunState(opts), "reply run state");
      runState.replyCompletion = resolveReplyCompletion("optional", "empty");
      return undefined;
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          BodyForAgent: "queue this turn",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onDeferred: vi.fn(),
            onSettled: vi.fn(),
          },
        },
        replyResolver,
      });

      expect(result).toMatchObject({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
      expect(result.deliberateSilentTerminalReply).toBeUndefined();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)).toBe(activeOperation);
    } finally {
      activeOperation.complete();
    }
  });

  it("lets Gateway-owned turns reach queue resolution while only an embedded run is active", async () => {
    setNoAbort();
    const sessionKey = "agent:main:main";
    const sessionId = "active-embedded-session";
    const activeHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    const activeOperation = setActiveEmbeddedRun(
      sessionId,
      activeHandle,
      sessionKey,
      undefined,
      undefined,
      undefined,
      undefined,
      { storeScope: mockSessionStorePath },
    );
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)).toBe(activeOperation);
      const runState = expectDefined(resolveReplyOperationRunState(opts), "reply run state");
      runState.replyCompletion = resolveReplyCompletion("optional", "empty");
      return undefined;
    });

    try {
      const result = await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "webchat",
          Surface: "webchat",
          SessionKey: sessionKey,
          BodyForAgent: "steer this active turn",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: {
          turnAdoptionLifecycle: {
            onAdopted: async () => {},
            onDeferred: vi.fn(),
            onSettled: vi.fn(),
          },
        },
        replyResolver,
      });

      expect(result).toMatchObject({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      });
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
      expect(result.deliberateSilentTerminalReply).toBeUndefined();
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)).toBe(activeOperation);
    } finally {
      clearActiveEmbeddedRun(sessionId, activeHandle, sessionKey);
    }
  });

  it("keeps non-Gateway turns on normal admission after the embedded predecessor settles", async () => {
    setNoAbort();
    const sessionKey = "agent:main:telegram:direct:embedded-only";
    const sessionId = "active-non-gateway-embedded-session";
    const activeHandle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    const predecessor = setActiveEmbeddedRun(
      sessionId,
      activeHandle,
      sessionKey,
      undefined,
      undefined,
      undefined,
      undefined,
      { storeScope: mockSessionStorePath },
    );
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    hookMocks.runner.hasHooks.mockImplementation((hookName) => hookName === "before_dispatch");
    hookMocks.runner.runBeforeDispatch.mockImplementationOnce(async () => {
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)).toBe(predecessor);
      clearActiveEmbeddedRun(sessionId, activeHandle, sessionKey);
      await predecessor.ownerSettlement;
      return undefined;
    });
    const replyResolver = vi.fn(async () => {
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)?.sessionId).toBe(sessionId);
      expect(dispatchHarness.getSessionControllerOperation(sessionKey)).not.toBe(predecessor);
      return undefined;
    });

    try {
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          Surface: "telegram",
          SessionKey: sessionKey,
          BodyForAgent: "queue through normal admission",
        }),
        cfg: emptyConfig,
        dispatcher: createDispatcher(),
        replyResolver,
      });

      expect(replyResolver).toHaveBeenCalledTimes(1);
    } finally {
      clearActiveEmbeddedRun(sessionId, activeHandle, sessionKey);
    }
  });

  it.each([
    {
      name: "marks a clean no-stale terminal recovery so a racing visible turn cannot force-clear it",
      sessionKey: "agent:main:telegram:group:-1003774691297",
      sessionId: "failed-session-no-stale-race",
      firstMessageSid: "visible-no-stale-first",
      secondMessageSid: "visible-no-stale-second",
    },
  ])("$name", async ({ sessionKey, sessionId, firstMessageSid, secondMessageSid }) => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId,
      updatedAt: Date.now(),
      status: "failed",
    };

    const { promise: firstResolverGate, resolve: releaseFirstTurn } = createDeferred();
    const { promise: firstTurnEntered, resolve: signalFirstResolverEntered } = createDeferred();
    const firstReplyResolver = vi.fn(async () => {
      signalFirstResolverEntered();
      await firstResolverGate;
      return { text: "first recovery reply" } satisfies ReplyPayload;
    });
    const secondReplyResolver = vi.fn(
      async () => ({ text: "second reply" }) satisfies ReplyPayload,
    );
    const firstDispatcher = createDispatcher();
    const secondDispatcher = createDispatcher();
    const buildRaceCtx = (messageSid: string) =>
      buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        ChatType: "group",
        SessionKey: sessionKey,
        MessageSid: messageSid,
        To: "telegram:-1003774691295",
        BodyForAgent: "@openclaw recover",
      });

    const firstTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx(firstMessageSid),
      cfg: automaticGroupReplyConfig,
      dispatcher: firstDispatcher,
      replyResolver: firstReplyResolver,
    });
    await firstTurnEntered;
    const recoveryOperation = dispatchHarness.getSessionControllerOperation(sessionKey);
    expect(recoveryOperation).toBeDefined();
    // Clean admission must carry the recovery marker or the racing turn can force-clear it.
    expect(recoveryOperation?.terminalRecovery).toBe(true);

    const secondTurn = dispatchReplyFromConfig({
      ctx: buildRaceCtx(secondMessageSid),
      cfg: automaticGroupReplyConfig,
      dispatcher: secondDispatcher,
      replyResolver: secondReplyResolver,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(recoveryOperation?.result).toBeNull();
    expect(secondReplyResolver).not.toHaveBeenCalled();

    releaseFirstTurn();
    const [firstResult, secondResult] = await Promise.all([firstTurn, secondTurn]);
    expect(recoveryOperation?.result).toMatchObject({ kind: "completed" });
    expect(firstReplyResolver).toHaveBeenCalledTimes(1);
    expect(secondReplyResolver).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({ queuedFinal: true });
    expect(secondResult).toMatchObject({ queuedFinal: true });
    expect(firstDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(secondDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(dispatchHarness.isSessionRunActiveForKey(sessionKey)).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
