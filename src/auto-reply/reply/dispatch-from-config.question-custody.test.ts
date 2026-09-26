import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import type { AgentQuestionDispatcher } from "../../agents/harness/gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  registerPendingAgentQuestion,
} from "../../agents/harness/gateway-question.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../../agents/harness/host-private-capabilities.js";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { resolveReplyCompletion } from "../../agents/reply-completion.js";
import {
  copyConversationBindingRouteFacts,
  readConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createTestUserTurnTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runReplyQuestionInput } from "./agent-runner-question-input.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  automaticGroupReplyConfig,
  createReplyOperation,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  firstToolResultPayload,
  replyRunRegistry,
  requireToolResultHandler,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  clearAgentHarnesses();
});
it.each(["native commands", "groups"] as const)(
  "delivers deterministic exec approval tool payloads in %s with progress suppression",
  async (kind) => {
    setNoAbort();
    const cfg = kind === "groups" ? automaticGroupReplyConfig : emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx(
      kind === "groups"
        ? { Provider: "telegram", ChatType: "group" }
        : { Provider: "telegram", CommandSource: "native" },
    );

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      const runState = resolveReplyOperationRunState(opts);
      if (!runState) {
        throw new Error("expected reply operation run state");
      }
      runState.replyCompletion = resolveReplyCompletion(
        runState.replyCompletion?.expectation ?? "required",
        "blocked",
      );
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)?.channelData).toStrictEqual({
      execApproval: {
        approvalId: "117ba06d-1111-2222-3333-444444444444",
        approvalSlug: "117ba06d",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(await dispatcher.waitForIdle()).toMatchObject({
      counts: { tool: { delivered: 1 }, final: { delivered: 0 } },
    });
  },
);
it("delivers approval-unavailable notices when verbose tool progress is disabled", async () => {
  setNoAbort();
  const payload = {
    text: "Exec approval is unavailable.",
    channelData: {
      execApprovalUnavailable: { reason: "no-approval-route" },
    },
  } satisfies ReplyPayload;
  const finalReply = { text: "The command could not run without an approval route." };
  const dispatcher = createDispatcher();
  const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });
  const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions, _cfg?: OpenClawConfig) => {
    await requireToolResultHandler(opts?.onToolResult)(payload);
    return finalReply;
  };

  await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

  expect(dispatcher.sendToolResult).toHaveBeenCalledWith(payload);
  expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(finalReply);
});

function createQuestionDispatch(name: string) {
  const key = `agent:main:discord:direct:question-${name}`;
  const sessionId = `question-${name}`;
  sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
  const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
  const cancel = vi.fn();
  operation.attachBackend({ kind: "cli", runId: "independent-question-run", cancel });
  operation.setPhase("running");
  return {
    operation,
    cancel,
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      ChatType: "direct",
      From: "user:question-fixture",
      To: "channel:question-fixture",
      SessionKey: key,
      MessageSid: `question-answer-${name}`,
      BodyForAgent: "answer",
    }),
  };
}

describe("dispatch input custody after a question response", () => {
  it("keeps an authorized registered plugin command out of a pending question", async () => {
    const sessionKey = "agent:main:discord:direct:plugin-command-question";
    sessionStoreMocks.currentEntry = {
      sessionId: "plugin-command-question",
      updatedAt: Date.now(),
    };
    const pluginHandler = vi.fn(async () => ({ text: "paired" }));
    expect(
      registerPluginCommand("test-plugin", {
        name: "pair-test",
        description: "Pair test command",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });
    const resolved = vi.fn();
    const gatewayCall: AgentQuestionDispatcher = {
      version: 2,
      call: async (request) => {
        if (request.authority.kind === "source-bound") {
          request.authority.assertCurrent();
        }
        if (request.method === "question.resolve") {
          resolved();
        }
        return {};
      },
    };
    const question = registerPendingAgentQuestion({
      sessionKey,
      questionId: "ask_plugin_command_question",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      gatewayCall,
    });
    question.attachRegistration(Promise.resolve());
    const command = "/pair-test";
    const replyResolver = vi.fn(async () => ({ text: "normal command path" }));
    try {
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          From: "user:plugin-command",
          To: "channel:plugin-command",
          SessionKey: sessionKey,
          MessageSid: "plugin-command-answer",
          Body: command,
          RawBody: command,
          BodyForAgent: command,
          BodyForCommands: command,
          CommandBody: command,
          CommandSource: "text",
          CommandAuthorized: true,
        }),
        cfg: { ...automaticDirectReplyConfig, commands: { text: true } },
        dispatcher: createDispatcher(),
        replyResolver,
      });

      expect(replyResolver).toHaveBeenCalledOnce();
      expect(resolved).not.toHaveBeenCalled();
      await expect(claimPendingAgentQuestionAnswer({ sessionKey, text: "Continue" })).resolves.toBe(
        true,
      );
      expect(resolved).toHaveBeenCalledOnce();
    } finally {
      question.dispose();
    }
  });

  it.each([
    ["before dispatch", "before-dispatch"],
    ["after claim entry", "after-claim"],
  ] as const)("refuses a reassigned conversation binding %s", async (when, slug) => {
    const sessionKey = `agent:main:webchat:direct:stale-binding-${slug}`;
    const conversation = {
      channel: "webchat",
      accountId: "default",
      conversationId: `stale-binding-${slug}`,
    };
    const observed: SessionBindingRecord = {
      bindingId: "binding-observed",
      boundAt: 1,
      targetKind: "session",
      targetSessionKey: sessionKey,
      conversation,
      status: "active",
    };
    const reassigned: SessionBindingRecord = {
      ...observed,
      bindingId: "binding-reassigned",
      boundAt: 2,
    };
    let binding = when === "before dispatch" ? reassigned : observed;
    sessionStoreMocks.currentEntry = {
      sessionId: `stale-binding-${slug}`,
      updatedAt: Date.now(),
    };
    const resolved = vi.fn();
    const gatewayCall: AgentQuestionDispatcher = {
      version: 2,
      call: async (request) => {
        if (request.method === "question.resolve") {
          resolved();
        }
        return {};
      },
    };
    let claimStarted = false;
    let releaseRegistration = () => {};
    const registration =
      when === "before dispatch"
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            releaseRegistration = resolve;
          });
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      fingerprint: "binding-question",
      project: () => "binding-question",
      assertActive: () => {
        claimStarted = true;
      },
    });
    const question = withAgentQuestionAnswerAuthority(authority, () =>
      registerPendingAgentQuestion({
        sessionKey,
        questionId: `ask_stale_binding_${slug}`,
        questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
        gatewayCall,
      }),
    );
    question.attachRegistration(registration);
    const adapter: SessionBindingAdapter = {
      channel: conversation.channel,
      accountId: conversation.accountId,
      listBySession: () => [binding],
      inspectByConversation: () => binding,
      inspectByConversationAsync: async () => binding,
      resolveByConversation: () => binding,
      resolveByConversationAsync: async () => binding,
      touchAsync: async () => undefined,
    };
    registerSessionBindingAdapter(adapter);
    const route = withConversationBindingRouteFacts(
      { sessionKey, agentId: "main" },
      { kind: "agent", binding: observed, sessionKey },
      "main",
      conversation,
    );
    const answer = "Continue";
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      From: `user:${slug}`,
      To: `channel:${slug}`,
      AgentId: "main",
      SessionKey: sessionKey,
      MessageSid: `${slug}-answer`,
      Body: answer,
      RawBody: answer,
      BodyForAgent: answer,
      BodyForCommands: answer,
      CommandBody: answer,
      CommandSource: "text",
      CommandAuthorized: true,
    });
    copyConversationBindingRouteFacts(route, ctx);
    const routeFacts = readConversationBindingRouteFacts(ctx);
    expect(routeFacts?.kind === "agent" ? routeFacts.bindingId : undefined).toBe(
      "binding-observed",
    );
    const replyResolver = vi.fn(async () => ({ text: "should not start a turn" }));
    const pending = dispatchReplyFromConfig({
      ctx,
      cfg: automaticDirectReplyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    try {
      if (when === "after claim entry") {
        await vi.waitFor(() => expect(claimStarted).toBe(true));
        binding = reassigned;
        releaseRegistration();
      }
      await expect(pending).rejects.toMatchObject({
        code: "SESSION_WORK_START_CHANGED",
        message: expect.stringContaining("Conversation binding changed"),
      });
      expect(resolved).not.toHaveBeenCalled();
      expect(replyResolver).not.toHaveBeenCalled();
    } finally {
      releaseRegistration();
      unregisterSessionBindingAdapter({
        channel: adapter.channel,
        accountId: adapter.accountId,
        adapter,
      });
      question.dispose();
    }
  });

  it("persists a staged inbound answer before question resolution", async () => {
    const sessionKey = "agent:main:webchat:direct:staged-question";
    const sessionId = "staged-question";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ask-user-staged-"));
    const storePath = path.join(dir, "sessions.sqlite");
    const target = createTestUserTurnTranscriptTarget({ sessionId, sessionKey, storePath });
    const answer = "Continue";
    sessionStoreMocks.currentEntry = { sessionId, updatedAt: Date.now() };
    const order: string[] = [];
    const resolved = vi.fn();
    const adapter: SessionBindingAdapter = {
      channel: "webchat",
      accountId: "default",
      listBySession: () => [],
      inspectByConversation: () => null,
      inspectByConversationAsync: async () => null,
      resolveByConversation: () => null,
      resolveByConversationAsync: async () => null,
      touchAsync: async () => undefined,
    };
    registerSessionBindingAdapter(adapter);
    try {
      await replaceSessionEntry(target, { sessionId, updatedAt: Date.now() });
      const recorder = createUserTurnTranscriptRecorder({
        target,
        input: { text: answer, idempotencyKey: "staged-question:user" },
      });
      expect(
        await recorder.stageApproved?.({ runId: "staged-question", assertCurrent: () => {} }),
      ).toBe(true);
      expect(listSessionPendingInputs(target).total).toBe(1);
      const persist = recorder.persistApproved.bind(recorder);
      vi.spyOn(recorder, "persistApproved").mockImplementation(async (options) => {
        const result = await persist(options);
        order.push(recorder.hasPersisted() ? "persisted" : "not-persisted");
        return result;
      });
      const authority = createAgentQuestionAnswerAuthority({
        sessionKey,
        fingerprint: "staged-question",
        project: () => "staged-question",
        assertActive: () => {},
        admitTranscriptAnswer: (source) => {
          order.push(source?.hasPersisted() ? "admitted" : "not-admitted");
        },
      });
      const gatewayCall: AgentQuestionDispatcher = {
        version: 2,
        call: async (request) => {
          if (request.method === "question.resolve") {
            order.push("resolved");
            resolved();
          }
          return {};
        },
      };
      const question = withAgentQuestionAnswerAuthority(authority, () =>
        registerPendingAgentQuestion({
          sessionKey,
          questionId: "ask_staged",
          questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
          gatewayCall,
        }),
      );
      question.attachRegistration(Promise.resolve());
      const replyResolver = vi.fn(async () => ({ text: "should not start a turn" }));
      try {
        await dispatchReplyFromConfig({
          ctx: buildTestCtx({
            Provider: "webchat",
            Surface: "webchat",
            ChatType: "direct",
            From: "user:staged-question",
            To: "channel:staged-question",
            AgentId: "main",
            SessionKey: sessionKey,
            MessageSid: "staged-question-answer",
            Body: answer,
            RawBody: answer,
            BodyForAgent: answer,
            BodyForCommands: answer,
            CommandBody: answer,
            CommandSource: "text",
            CommandAuthorized: true,
          }),
          cfg: automaticDirectReplyConfig,
          dispatcher: createDispatcher(),
          replyOptions: { userTurnTranscriptRecorder: recorder },
          replyResolver,
        });
        expect(order).toEqual(["persisted", "admitted", "resolved"]);
        expect(listSessionPendingInputs(target).total).toBe(0);
        expect(await readTranscriptMessages({ sessionId, sessionKey, storePath })).toEqual([
          expect.objectContaining({ role: "user", content: answer }),
        ]);
        expect(resolved).toHaveBeenCalledOnce();
        expect(replyResolver).not.toHaveBeenCalled();
      } finally {
        unregisterSessionBindingAdapter({
          channel: adapter.channel,
          accountId: adapter.accountId,
          adapter,
        });
        question.dispose();
      }
    } finally {
      await closeOpenClawAgentDatabasesAsync(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Real question/receipt classification is covered by the wire regression. Here
  // the real dispatch owner must preserve that recorded fact through source faults.
  it.each(
    ["confirmed", "indeterminate"].flatMap((outcome) =>
      ["settlement-error", "source-abort"].map((failure) => ({ outcome, failure })),
    ),
  )("does not replay $outcome input after $failure", async ({ outcome, failure }) => {
    const fixture = createQuestionDispatch(`${outcome}-${failure}`);
    const abort = new AbortController();
    const cleanupError = new Error("source settlement failed");
    const onAdopted = vi.fn(async () => {
      throw new Error("source adoption closed");
    });
    const onSettled = vi.fn(() => {
      if (failure === "source-abort") {
        abort.abort();
      } else {
        throw cleanupError;
      }
    });
    const resolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      const state = resolveReplyOperationRunState(opts);
      if (!state) {
        throw new Error("missing dispatch run state");
      }
      state.admission =
        outcome === "confirmed"
          ? { status: "accepted", mode: "steer" }
          : { status: "skipped", reason: "question-response-indeterminate" };
      const input = { turnAdoptionLifecycle: opts?.turnAdoptionLifecycle };
      await admitFollowupRunLifecycle(input).catch(() => {});
      completeFollowupRunLifecycle(input, "consumed");
      return undefined;
    });
    try {
      const first = dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: {
          abortSignal: abort.signal,
          turnAdoptionLifecycle: { onAdopted, onSettled },
        },
        replyResolver: resolver,
      });
      if (failure === "settlement-error") {
        await expect(first).rejects.toBe(cleanupError);
      } else {
        await expect(first).resolves.toMatchObject({ queuedFinal: false });
      }
      const replay = vi.fn(async () => ({ text: "must not replay" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: replay,
      });
      expect(replay).not.toHaveBeenCalled();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onSettled).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.operation.result).toBeNull();
      expect(replyRunRegistry.get(fixture.operation.key)).toBe(fixture.operation);
    } finally {
      fixture.operation.complete();
    }
  });

  it.each(["question-response-indeterminate", "question-response-refused"] as const)(
    "delivers %s and records an error instead of a successful agent turn",
    async (reason) => {
      const fixture = createQuestionDispatch(reason);
      const dispatcher = createDispatcher();
      const notice =
        reason === "question-response-indeterminate"
          ? "The question answer could not be confirmed; check before retrying."
          : "The question answer was refused; check your permissions before retrying.";
      try {
        await dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
          dispatcher,
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async (_ctx, opts) => {
            const state = resolveReplyOperationRunState(opts);
            if (!state) {
              throw new Error("missing dispatch run state");
            }
            state.admission = { status: "skipped", reason };
            return { text: notice, isError: true };
          },
        });
        expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: notice, isError: true });
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", reason }),
        );
        expect(fixture.cancel).not.toHaveBeenCalled();
        expect(fixture.operation.result).toBeNull();
      } finally {
        fixture.operation.complete();
      }
    },
  );

  it("delivers a host question refusal when the agent owns normal replies", async () => {
    const fixture = createQuestionDispatch("host-refusal");
    const dispatcher = createDispatcher();
    const question = registerPendingAgentQuestion({
      sessionKey: fixture.operation.key,
      questionId: "ask_unbound_source",
      questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve());
    try {
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
        replyResolver: async (ctx, opts) => {
          const result = await runReplyQuestionInput({
            commandBody: "answer",
            followupRun: createQueueTestRun({ prompt: "answer" }),
            sessionKey: fixture.operation.key,
            sessionCtx: ctx,
            opts,
          });
          expect(result.handled).toBe(true);
          return result.handled ? result.payload : undefined;
        },
      });
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("The answer was not sent"),
          isError: true,
        }),
      );
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("reports an incomplete multi-question answer and keeps the question open", async () => {
    const fixture = createQuestionDispatch("incomplete-answer");
    const dispatcher = createDispatcher();
    const broker = new EmbeddedQuestionBroker();
    const questionId = "ask_incomplete_answer";
    const questions = [
      { id: "destination", header: "Where", question: "Where to?" },
      { id: "budget", header: "Budget", question: "How much?" },
    ];
    broker.request({
      id: questionId,
      sessionKey: fixture.operation.key,
      questions: questions.map(({ id, ...question }) => ({
        ...question,
        questionId: id,
        options: [],
      })),
    });
    const onResolved = vi.fn();
    broker.subscribe((event) => {
      if (event.event === "question.resolved") {
        onResolved(event.payload);
      }
    });
    const onResumed = vi.fn();
    const answer = broker.waitAnswer({ id: questionId, includeResolutionId: true });
    const resumed = answer.then(onResumed);
    const gatewayCall: AgentQuestionDispatcher = {
      version: 2,
      call: async ({ method, params, authority }) => {
        if (authority.kind === "source-bound") {
          authority.assertCurrent();
        }
        return broker.call(method, params);
      },
    };
    // The creator authority the source-bound claim path requires; this fixture
    // accepts any caller so the test exercises answer validation, not policy.
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey: fixture.operation.key,
      fingerprint: "question-custody-fixture",
      project: () => "question-custody-fixture",
      assertActive: () => {},
    });
    const question = withAgentQuestionAnswerAuthority(authority, () =>
      registerPendingAgentQuestion({
        sessionKey: fixture.operation.key,
        questionId,
        questions,
        gatewayCall,
        answer,
      }),
    );
    question.attachRegistration(Promise.resolve());
    const replyResolver = vi.fn(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      const text = ctx.BodyForAgent;
      if (typeof text !== "string") {
        throw new Error("missing question answer text");
      }
      const result = await runReplyQuestionInput({
        commandBody: text,
        followupRun: createQueueTestRun({ prompt: text }),
        sessionKey: fixture.operation.key,
        sessionCtx: ctx,
        opts,
      });
      expect(result.handled).toBe(true);
      return result.handled ? result.payload : undefined;
    });
    const dispatch = (text: string, messageId: string) =>
      dispatchReplyFromConfig({
        ctx: { ...fixture.ctx, agentText: text, MessageSid: messageId },
        cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
        dispatcher,
        replyOptions: {
          sourceReplyDeliveryMode: "message_tool_only",
          turnAdoptionLifecycle: { onAdopted: async () => {} },
        },
        replyResolver,
      });
    try {
      await dispatch("Lisbon", "incomplete-answer");
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("The answer was not accepted: question 'budget'"),
          isError: true,
        }),
      );
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("still open") }),
      );
      expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "error", reason: "question-response-rejected" }),
      );
      expect(question.isResolving()).toBe(false);
      expect(broker.get({ id: questionId }).question).toMatchObject({ status: "pending" });
      expect(broker.get({ id: questionId }).question.answers).toBeUndefined();
      expect(onResolved).not.toHaveBeenCalled();
      expect(onResumed).not.toHaveBeenCalled();
      expect(fixture.cancel).not.toHaveBeenCalled();

      await dispatch("Lisbon", "incomplete-answer");
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
      expect(onResolved).not.toHaveBeenCalled();

      await dispatch("1: Lisbon\n2: 2000", "complete-answer");
      expect(broker.get({ id: questionId }).question).toMatchObject({
        status: "answered",
        answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
      });
      await resumed;
      expect(onResolved).toHaveBeenCalledExactlyOnceWith({
        id: questionId,
        status: "answered",
        answers: { answers: { destination: ["Lisbon"], budget: ["2000"] } },
      });
      expect(onResumed).toHaveBeenCalledOnce();
      expect(replyResolver).toHaveBeenCalledTimes(2);
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();

      await dispatch("1: Lisbon\n2: 2000", "complete-answer");
      expect(replyResolver).toHaveBeenCalledTimes(2);
      expect(onResolved).toHaveBeenCalledOnce();
      expect(onResumed).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      question.dispose();
      broker.stop();
      await resumed;
      fixture.operation.complete();
    }
  });

  it.each([
    { code: "INVALID_REQUEST", reason: "QUESTION_ID_IN_USE" },
    { code: "INVALID_REQUEST", reason: undefined },
    { code: "FORBIDDEN", reason: "QUESTION_INVALID_ANSWER" },
    { code: "UNAVAILABLE", reason: "QUESTION_INVALID_ANSWER" },
  ])("does not report $code/$reason as an invalid answer", async ({ code, reason }) => {
    const fixture = createQuestionDispatch(`rejection-${code}-${reason}`);
    const dispatcher = createDispatcher();
    const error = new GatewayClientRequestError({
      code,
      message: "question request failed",
      details: { reason },
    });
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey: fixture.operation.key,
      fingerprint: "question-custody-fixture",
      project: () => "question-custody-fixture",
      assertActive: () => {},
    });
    const question = withAgentQuestionAnswerAuthority(authority, () =>
      registerPendingAgentQuestion({
        sessionKey: fixture.operation.key,
        questionId: "ask_rejection_control",
        questions: [{ id: "answer", header: "Answer", question: "Continue?" }],
        answer: Promise.resolve({ status: "pending" }),
        gatewayCall: {
          version: 2,
          call: async () => {
            throw error;
          },
        },
      }),
    );
    question.attachRegistration(Promise.resolve());
    try {
      const result = dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: { ...automaticDirectReplyConfig, diagnostics: { enabled: true } },
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: async (ctx, opts) => {
          const reply = await runReplyQuestionInput({
            commandBody: "answer",
            followupRun: createQueueTestRun({ prompt: "answer" }),
            sessionKey: fixture.operation.key,
            sessionCtx: ctx,
            opts,
          });
          expect(reply.handled).toBe(true);
          return reply.handled ? reply.payload : undefined;
        },
      });
      if (code === "UNAVAILABLE") {
        await expect(result).resolves.toMatchObject({
          queuedFinal: true,
        });
        expect(question.isResolving()).toBe(true);
        expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            text: expect.stringContaining("confirmation was lost"),
            isError: true,
          }),
        );
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", reason: "question-response-indeterminate" }),
        );
      } else {
        await expect(result).rejects.toBe(error);
        expect(question.isResolving()).toBe(false);
        expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
        expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: "error", error: String(error) }),
        );
      }
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("The answer was not accepted") }),
      );
      expect(diagnosticMocks.logMessageProcessed).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: "question-response-rejected" }),
      );
      expect(fixture.cancel).not.toHaveBeenCalled();
      expect(fixture.operation.result).toBeNull();
      expect(replyRunRegistry.get(fixture.operation.key)).toBe(fixture.operation);
    } finally {
      question.dispose();
      fixture.operation.complete();
    }
  });

  it("still permits retry when the source failed before any input custody transfer", async () => {
    const fixture = createQuestionDispatch("before-custody");
    const error = new Error("failure before input dispatch");
    try {
      await expect(
        dispatchReplyFromConfig({
          ctx: fixture.ctx,
          cfg: automaticDirectReplyConfig,
          dispatcher: createDispatcher(),
          replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
          replyResolver: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
      const retry = vi.fn(async () => ({ text: "retry is safe" }));
      await dispatchReplyFromConfig({
        ctx: fixture.ctx,
        cfg: automaticDirectReplyConfig,
        dispatcher: createDispatcher(),
        replyOptions: { turnAdoptionLifecycle: { onAdopted: async () => {} } },
        replyResolver: retry,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(fixture.cancel).not.toHaveBeenCalled();
    } finally {
      fixture.operation.complete();
    }
  });
});
