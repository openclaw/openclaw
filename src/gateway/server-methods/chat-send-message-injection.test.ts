/** Covers the injection-start admission fence and steer finalize audit honesty. */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import {
  recordSessionParticipant,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  bindSessionControllerSourceTurnId,
  captureReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  captureSessionControllerSourceSettlement,
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatImageContent } from "../chat-attachments.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import {
  createChatSendMessageInjectionStarter,
  finalizeAcceptedChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../auto-reply/reply/dispatch-from-config.audit.js", () => ({
  emitInboundMessageAuditTerminal: vi.fn(),
}));
vi.mock(
  import("../../sessions/session-controller.message-injection.js"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      beginReplyMessageInjectionTarget: vi.fn<typeof actual.beginReplyMessageInjectionTarget>(),
      finalizeReplyMessageInjectionAttempt:
        vi.fn<typeof actual.finalizeReplyMessageInjectionAttempt>(),
    };
  },
);
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  updateSessionEntry: vi.fn(async () => undefined),
  recordSessionParticipant: vi.fn(async () => null),
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageProcessed: vi.fn(),
  logMessageReceived: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));
vi.mock("./chat-broadcast.js", () => ({
  broadcastChatFinal: vi.fn(),
  broadcastChatError: vi.fn(),
}));
vi.mock(import("../agent-turn/agent-job.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  setGatewayDedupeEntry: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn(() => ({})),
}));
// mock-isolation: Injection fixtures provide owner authority without command-owner database admission.
vi.mock("../../auto-reply/command-auth.js", () => ({
  resolveCommandAuthorizationAsync: vi.fn(() => ({ senderIsOwner: true })),
}));
vi.mock("../../auto-reply/reply/reply-tool-authority.js", () => ({
  resolveInboundReplyToolAuthorityOverlay: vi.fn(() => ({})),
}));

const {
  beginReplyMessageInjectionTarget: beginActualReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt: finalizeActualReplyMessageInjectionAttempt,
} = await vi.importActual<typeof import("../../sessions/session-controller.message-injection.js")>(
  "../../sessions/session-controller.message-injection.js",
);

function makeParams() {
  const context = {
    logGateway: { warn: vi.fn() },
    chatRunState: { hasAbortMarker: () => true },
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  return {
    context,
    ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
    attempt: {},
    persistUserTurnTranscriptBestEffort: vi.fn(async () => undefined),
    session: {
      agentId: "main",
      cfg: {},
      clientRunId: "run-1",
      entry: undefined,
      sessionKey: "agent:main:dashboard:s",
      storePath: "",
    },
    startedAt: Date.now(),
    target: {} as ReplyMessageInjectionTarget,
  } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0];
}

function makeFailClosedEntry() {
  return {
    sessionId: "session-1",
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
    restartRecoveryDeliveryReceiptState: "terminal-pending",
    restartRecoveryDeliveryToolCallId: "message-call-1",
    updatedAt: 1,
  } as never;
}

function reserveTestSource(
  sessionKey = "agent:main:dashboard:s",
  sessionId = "session-1",
  storeScope = "/synthetic/chat-injection",
): RpcSourceRef {
  const adapter = { scope: storeScope };
  const input = reserveSessionControllerSource(sessionKey, {
    adapter,
    policy: { mode: "steer" },
    target: captureSessionTarget({
      storeScope,
      agentId: "main",
      sessionKey,
      incarnation: sessionId,
    }),
  });
  onTestFinished(() => retireSessionControllerInput(input));
  return { input, adapter };
}

function makeStarterParams(params?: { entry?: unknown; sessionKey?: string; storePath?: string }) {
  const sessionKey = params?.sessionKey ?? "agent:main:dashboard:s";
  return {
    sourceRef: reserveTestSource(sessionKey, "session-1", params?.storePath),
    target: { runId: "run-1" } as ReplyMessageInjectionTarget,
    request: {
      p: {},
      rawMessage: "steer",
      supportsTaskSuggestions: false,
    },
    session: {
      agentId: "main",
      cfg: {},
      clientRunId: "run-1",
      entry: params?.entry as never,
      sessionKey,
      storePath: params?.storePath ?? "",
    },
    turn: {
      ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
      isInternalTextSlashCommandTurn: false,
      replyOptionImages: [],
      replyOptionMedia: [],
    },
    imageOrder: [],
    abortSignal: new AbortController().signal,
    userTurnTranscriptRecorder: {},
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof createChatSendMessageInjectionStarter>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(beginReplyMessageInjectionTarget).mockImplementation(async (target, _text, options) => {
    const admitted = options?.canAdmit?.() !== false;
    return {
      targetRunId: target.runId,
      acceptance: Promise.resolve(admitted),
      outcome: Promise.resolve(
        admitted ? { status: "accepted" } : { status: "rejected", reason: "injection_unavailable" },
      ),
    };
  });
});

describe("finalizeAcceptedChatSendMessageInjection", () => {
  it("audits a confirmed steer as completed active_run_injected", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: { status: "accepted" },
      targetRunId: "run-1",
      aborted: false,
    });
    const params = makeParams();
    const entry = Object.freeze({ sessionId: "session-1", updatedAt: 1 });
    params.session.entry = entry;
    prepareSessionParticipantInput(params.ctx, { type: "profile", id: "profile-steerer" }, 42);
    await finalizeAcceptedChatSendMessageInjection(params);
    expect(recordSessionParticipant).toHaveBeenCalledOnce();
    expect(recordSessionParticipant).toHaveBeenCalledWith(expect.anything(), {
      identity: { type: "profile", id: "profile-steerer" },
      promptedAt: 42,
      sessionAgentId: "main",
    });

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "active_run_injected" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "completed", options: { reason: "active_run_injected" } },
      }),
    );
    expect(updateSessionEntry).toHaveBeenCalledOnce();
    expect(entry.updatedAt).toBe(1);
    expect(params.session.entry?.updatedAt).toBeGreaterThan(1);
  });

  it("reports indeterminate question input without claiming success or falling back", async () => {
    const errorMessage = "Could not confirm the question response; do not replay it.";
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "indeterminate",
      outcome: { status: "indeterminate", errorMessage },
      targetRunId: "backing-run",
      adoptionError: undefined,
    });
    const params = makeParams();
    params.context.chatRunState.hasAbortMarker = () => false;
    await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(true);
    expect(broadcastChatError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", errorMessage }),
    );
    expect(broadcastChatFinal).not.toHaveBeenCalled();
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: {
          outcome: "error",
          options: { reason: "question_response_indeterminate", error: errorMessage },
        },
      }),
    );
  });
});

describe("createChatSendMessageInjectionStarter admission fence", () => {
  it.for([
    "normal",
    "terminal receipt",
    "active source tombstone",
    "unrelated tombstone",
    "caller revoked",
  ] as const)(
    "rechecks terminal admission after awaited projection: %s",
    async (change, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const initial = { sessionId: "session-1", updatedAt: 1 };
        const sessionKey = `agent:main:dashboard:projection-${change.replaceAll(" ", "-")}`;
        const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
        const scope = { agentId: "main", sessionKey, storePath };
        await upsertSessionEntryCore(scope, initial);
        let callerCurrent = true;
        const refusal = new Error("caller authority revoked during projection");
        const entered = createDeferred();
        const resume = createDeferred();
        const operation = createReplyOperation({
          sessionKey,
          sessionId: initial.sessionId,
          target: captureSessionTarget({
            storeScope: storePath,
            sessionKey,
            incarnation: initial.sessionId,
            agentId: "main",
          }),
          resetTriggered: false,
        });
        const params = makeStarterParams({ entry: initial, sessionKey, storePath });
        params.assertCurrent = () => {
          if (!callerCurrent) {
            throw refusal;
          }
        };
        operation.bindToolAuthoritySnapshot({
          fingerprint: () => "authority",
          project: () => "authority",
          projectAsync: async () => {
            entered.resolve();
            await withinTest(resume.promise, signal);
            return "authority";
          },
        });
        operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
        const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
          async (_text, _options, assertCurrent) => {
            assertCurrent();
          },
        );
        operation.attachBackend({
          kind: "embedded",
          runId: "active-run",
          supportsTranscriptCommitWait: true,
          toolAuthorityFingerprint: "authority",
          cancel() {},
          messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
        });
        operation.setPhase("running");
        bindSessionControllerSourceTurnId(operation, "source-1");
        params.target = expectDefined(
          captureReplyMessageInjectionTarget(operation),
          "active injection target",
        );
        vi.mocked(beginReplyMessageInjectionTarget).mockImplementationOnce(
          beginActualReplyMessageInjectionTarget,
        );
        const sql = observeMainThreadSql();
        const starting = createChatSendMessageInjectionStarter(params)();
        const outcome = starting.then(
          (attempt) => ({ attempt }),
          (error: unknown) => ({ error }),
        );
        try {
          await withinTest(
            awaitGateBeforeSettlement(entered.promise, starting, "Projection did not await"),
            signal,
          );
          expect(queueMessage).not.toHaveBeenCalled();
          if (change === "terminal receipt" || change === "caller revoked") {
            await upsertSessionEntryCore(scope, {
              restartRecoveryDeliveryRunId: "recovery-1",
              restartRecoveryDeliverySourceRunId: "source-1",
              restartRecoveryDeliveryReceiptState: "delivered-terminal",
            });
          } else if (change === "active source tombstone" || change === "unrelated tombstone") {
            await upsertSessionEntryCore(scope, {
              restartRecoveryTerminalRunIds: [
                change === "active source tombstone" ? "source-1" : "source-old",
              ],
            });
          }
          callerCurrent = change !== "caller revoked";
          resume.resolve();
          const result = await outcome;
          sql.expectIdle();
          if (change === "caller revoked") {
            expect(result).toEqual({ error: refusal });
            expect(queueMessage).not.toHaveBeenCalled();
          } else if (change === "normal" || change === "unrelated tombstone") {
            if (!("attempt" in result) || !result.attempt) {
              throw new Error("Expected current terminal authority to admit steering", {
                cause: result,
              });
            }
            await expect(result.attempt.outcome).resolves.toMatchObject({ status: "accepted" });
            expect(queueMessage).toHaveBeenCalledOnce();
          } else {
            expect(result).toEqual({ attempt: undefined });
            expect(queueMessage).not.toHaveBeenCalled();
          }
        } finally {
          resume.resolve();
          const result = await outcome;
          if ("attempt" in result) {
            await result.attempt?.outcome;
          }
          sql.restore();
          operation.complete();
        }
      });
    },
  );

  it.each(["unbound", "current", "refused"] as const)(
    "composes captured terminal admission with %s authority",
    async (authority) => {
      // A captured terminal receipt rejects steering, but must not swallow
      // an independent authority refusal into the follow-up return value.
      const params = makeStarterParams({ entry: makeFailClosedEntry() });
      const refusal = new Error("injection authority refused");
      const assertCurrent = () => {
        if (authority === "refused") {
          throw refusal;
        }
      };
      if (authority !== "unbound") {
        params.assertCurrent = assertCurrent;
      }
      const begin = createChatSendMessageInjectionStarter(params);

      if (authority === "refused") {
        await expect(begin()).rejects.toBe(refusal);
        expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
      } else {
        expect(await begin()).toBeUndefined();
        expect(params.logGateway.warn).toHaveBeenCalled();
      }
    },
  );

  it("reads current terminal eligibility when the captured request snapshot is stale", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:initial-steering",
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      };
      for (const blocked of [true, false]) {
        await upsertSessionEntryCore(scope, {
          sessionId: "session-1",
          updatedAt: 1,
          restartRecoveryDeliveryReceiptState: blocked ? "terminal-pending" : undefined,
        });
        const params = makeStarterParams({
          entry: blocked ? undefined : makeFailClosedEntry(),
          ...scope,
        });
        const attempt = await createChatSendMessageInjectionStarter(params)();
        if (blocked) {
          expect(attempt).toBeUndefined();
          expect(params.logGateway.warn).toHaveBeenCalled();
        } else {
          await expect(attempt?.outcome).resolves.toMatchObject({ status: "accepted" });
        }
        retireSessionControllerInput(params.sourceRef.input);
      }
    });
  });

  it("falls back without queuing when durable terminal metadata is unreadable", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = await state.writeText(
        "agents/main/agent/openclaw-agent.sqlite",
        "unreadable session database",
      );
      const params = makeStarterParams({
        entry: { sessionId: "session-1", updatedAt: 1 },
        storePath,
      });

      await expect(createChatSendMessageInjectionStarter(params)()).resolves.toBeUndefined();
      expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
      expect(params.logGateway.warn).toHaveBeenCalledWith(
        "chat steering rejected; falling back to follow-up dispatch",
        expect.objectContaining({ reason: "terminal-delivery-unavailable" }),
      );
    });
  });
});

describe("gateway steer contract after the injection-start fence", () => {
  it.each([false, true])(
    "keeps work alive after an uncertain steer (statusOnly=%s)",
    async (statusOnly) => {
      const operation = createReplyOperation({
        sessionKey: "agent:main:dashboard:s",
        sessionId: "session-1",
        target: captureSessionTarget({
          storeScope: "/synthetic/chat-injection",
          sessionKey: "agent:main:dashboard:s",
          incarnation: "session-1",
          agentId: "main",
        }),
        resetTriggered: false,
      });
      onTestFinished(() => operation.complete());
      const starter = makeStarterParams();
      if (statusOnly) {
        starter.turn.ctx.InputProvenance = {
          kind: "internal_system",
          sourceTool: "progress_card_refresh",
        };
      }
      const cancel = vi.fn();
      operation.bindToolAuthoritySnapshot({
        fingerprint: () => "steer-authority",
        project: () => "steer-authority",
      });
      operation.bindToolAuthorityRoute({ provider: "test", model: "test" });
      const errorMessage = "Steering receipt unavailable; do not replay this input.";
      const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
        async (_text, options, assertCurrent) => {
          assertCurrent();
          options?.onQueueAccepted?.(true);
          return { transcriptCommit: "unconfirmed", errorMessage };
        },
      );
      operation.attachBackend({
        kind: "embedded",
        runId: "backing-run",
        supportsTranscriptCommitWait: true,
        toolAuthorityFingerprint: "steer-authority",
        cancel,
        messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
      });
      operation.setPhase("running");
      starter.target = expectDefined(
        captureReplyMessageInjectionTarget(operation),
        "active steering target",
      );
      vi.mocked(beginReplyMessageInjectionTarget).mockImplementationOnce(
        beginActualReplyMessageInjectionTarget,
      );
      vi.mocked(finalizeReplyMessageInjectionAttempt).mockImplementationOnce(
        finalizeActualReplyMessageInjectionAttempt,
      );
      const attempt = expectDefined(
        await createChatSendMessageInjectionStarter(starter)(),
        "steering attempt",
      );
      await expect(attempt.outcome).resolves.toMatchObject({
        status: "indeterminate",
        errorMessage,
      });
      await expect(attempt.acceptance).resolves.toBe(true);
      const params = makeParams();
      params.ctx = starter.turn.ctx;
      params.attempt = attempt;
      params.target = starter.target;
      params.context.chatRunState.hasAbortMarker = () => false;
      await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(true);
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.abortSignal.aborted).toBe(false);
      expect(operation.phase).toBe("running");
      expect(params.persistUserTurnTranscriptBestEffort).toHaveBeenCalledOnce();
      expect(broadcastChatError).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", errorMessage }),
      );
      expect(broadcastChatFinal).not.toHaveBeenCalled();
      expect(params.context.logGateway.warn).not.toHaveBeenCalled();
      expect(setGatewayDedupeEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "chat:run-1",
          entry: expect.objectContaining({
            ok: statusOnly,
            payload: expect.objectContaining({ status: statusOnly ? "accepted" : "error" }),
          }),
        }),
      );
    },
  );

  it("routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued", async () => {
    // Mock-gateway contract: the pre-ACK path creates the starter, invokes
    // it after preparation, and hands the inbound to follow-up dispatch whenever
    // no injection attempt exists. A terminal receipt present at the
    // injection-start boundary must yield exactly one delivery path — the
    // follow-up dispatch — and zero runtime queueMessage calls, instead of
    // the old post-enqueue rejection (steer already queued + fallback
    // second dispatch = inbound double delivery).
    const dispatchFollowup = vi.fn();
    const begin = createChatSendMessageInjectionStarter(
      makeStarterParams({ entry: makeFailClosedEntry() }),
    );

    const attempt = await begin();
    if (attempt) {
      throw new Error("unexpected injection attempt for a fail-closed session");
    }
    dispatchFollowup();

    expect(dispatchFollowup).toHaveBeenCalledOnce();
  });
});

describe("createChatSendMessageInjectionStarter", () => {
  function makeSteerStarterParams(params?: {
    body?: string;
    rawMessage?: string;
    media?: RuntimeMsgContext["media"];
    documentContext?: Parameters<
      typeof createChatSendMessageInjectionStarter
    >[0]["documentContext"];
    replyOptionImages?: ChatImageContent[];
    isInternalTextSlashCommandTurn?: boolean;
  }): Parameters<typeof createChatSendMessageInjectionStarter>[0] {
    const sessionKey = "agent:main:steer-test";
    const sessionId = "steer-test-session";
    const rawMessage = params?.rawMessage ?? params?.body ?? "raw steer";
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      target: captureSessionTarget({
        storeScope: "/synthetic/chat-injection",
        sessionKey,
        incarnation: sessionId,
        agentId: "main",
      }),
      resetTriggered: false,
    });
    onTestFinished(() => operation.complete());
    const sourceRef = reserveTestSource(sessionKey, sessionId);
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "active-run",
      supportsQueueMessageImages: true,
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn(async () => {}),
      },
    });
    const target = expectDefined(
      captureReplyMessageInjectionTarget(operation),
      "Expected the running test operation to accept steering",
    );

    return {
      target,
      sourceRef,
      abortSignal: new AbortController().signal,
      request: {
        p: { sessionKey, message: rawMessage, idempotencyKey: "steer-input" },
        rawMessage,
        supportsTaskSuggestions: false,
      },
      session: {
        agentId: "main",
        cfg: {},
        entry: undefined,
        sessionKey,
        storePath: "",
        clientRunId: "active-run",
      },
      turn: {
        ctx: { Provider: "dashboard", Body: params?.body, media: params?.media },
        isInternalTextSlashCommandTurn: params?.isInternalTextSlashCommandTurn ?? false,
        replyOptionImages: params?.replyOptionImages ?? [],
        replyOptionMedia: [],
      },
      imageOrder: [],
      documentContext: params?.documentContext,
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: params?.body ?? rawMessage, media: params?.media },
        target: createTestUserTurnTranscriptTarget({ sessionKey, sessionId }),
      }),
      logGateway: { warn: () => {} } as never,
    };
  }

  async function expectSteer(
    params: Parameters<typeof createChatSendMessageInjectionStarter>[0],
    text: string,
    options: Record<string, unknown> = { isInboundUserMessage: true },
  ) {
    const originalContext = structuredClone(params.turn.ctx);
    const attempt = await createChatSendMessageInjectionStarter(params)();
    await expect(attempt?.acceptance).resolves.toBe(true);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      params.target,
      text,
      expect.objectContaining(options),
    );
    expect(params.turn.ctx).toEqual(originalContext);
  }

  it.each([
    {
      caption: "see attached",
      label: "captioned",
      expectedText:
        '[media attached: media://inbound/note.txt (text/plain) "note.txt"]\n\nsee attached\n\n<file name="note.txt" mime="text/plain">doc body</file>',
    },
    {
      caption: "",
      label: "blank-caption",
      expectedText:
        '[media attached: media://inbound/note.txt (text/plain) "note.txt"]\n\n<file name="note.txt" mime="text/plain">doc body</file>',
    },
  ])("retains marker and document text for a $label steer", async ({ caption, expectedText }) => {
    const documentText = '<file name="note.txt" mime="text/plain">doc body</file>';
    const params = makeSteerStarterParams({
      body: caption,
      rawMessage: caption,
      media: [
        {
          path: "media://inbound/note.txt",
          contentType: "text/plain",
          kind: "document",
          fileName: "note.txt",
        },
      ],
      documentContext: { status: "rendered", text: documentText, images: [] },
    });
    await expectSteer(params, expectedText);
  });

  it("keeps the attachment note when document rendering fails", async () => {
    const params = makeSteerStarterParams({
      body: "read the attachment",
      media: [{ path: "media://inbound/note.txt", contentType: "text/plain" }],
      documentContext: { status: "failed" },
    });
    await expectSteer(
      params,
      "[media attached: media://inbound/note.txt (text/plain)]\n\nread the attachment",
    );
  });

  it("keeps the base text untouched when no document context was rendered", async () => {
    await createChatSendMessageInjectionStarter(makeSteerStarterParams({ body: "plain steer" }))();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "plain steer",
      expect.anything(),
    );
  });

  it("merges extracted page images after the prepared inbound images", async () => {
    const params = makeSteerStarterParams({
      body: "see attached",
      media: [
        { path: "media://inbound/photo.png", contentType: "image/png" },
        {
          path: "media://inbound/scan.pdf",
          contentType: "application/pdf",
          kind: "document",
        },
      ],
      replyOptionImages: [
        { type: "image", data: "inbound-photo", mimeType: "image/png", sourceIndex: 0 },
      ],
      documentContext: {
        status: "rendered",
        text: "[PDF content rendered to images]",
        images: [
          { type: "image", data: "page-1", mimeType: "image/png", attachmentIndex: 1 },
          { type: "image", data: "page-2", mimeType: "image/png", attachmentIndex: 1 },
        ],
      },
    });
    await expectSteer(
      params,
      "[media attached: 2 files]\n" +
        "[media attached 1/2: media://inbound/photo.png (image/png)]\n" +
        "[media attached 2/2: media://inbound/scan.pdf (application/pdf)]\n\n" +
        "see attached\n\n[PDF content rendered to images]",
      {
        images: [
          { type: "image", data: "inbound-photo", mimeType: "image/png", sourceIndex: 0 },
          { type: "image", data: "page-1", mimeType: "image/png", sourceIndex: 1 },
          { type: "image", data: "page-2", mimeType: "image/png", sourceIndex: 1 },
        ],
      },
    );
  });

  it("injects extracted page images when the steer carries no inbound images", async () => {
    await createChatSendMessageInjectionStarter(
      makeSteerStarterParams({
        body: "scan attached",
        documentContext: {
          status: "rendered",
          text: "[PDF content rendered to images]",
          images: [{ type: "image", data: "page-1", mimeType: "image/png", attachmentIndex: 0 }],
        },
      }),
    )();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "scan attached\n\n[PDF content rendered to images]",
      expect.objectContaining({
        images: [{ type: "image", data: "page-1", mimeType: "image/png", sourceIndex: 0 }],
      }),
    );
  });

  it("returns undefined for internal slash-command turns even with a target", async () => {
    expect(
      await createChatSendMessageInjectionStarter(
        makeSteerStarterParams({ isInternalTextSlashCommandTurn: true }),
      )(),
    ).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
  });
});

it("retains failed-acknowledgment steering custody until its native outcome actually settles", async () => {
  const params = makeStarterParams();
  const acknowledgment = createDeferredCore<boolean>();
  const nativeOutcome = createDeferredCore<Awaited<ReplyMessageInjectionAttempt["outcome"]>>();
  vi.mocked(beginReplyMessageInjectionTarget).mockResolvedValueOnce({
    targetRunId: "target",
    acceptance: acknowledgment.promise,
    outcome: nativeOutcome.promise,
  });
  const attempt = await createChatSendMessageInjectionStarter(params)();
  expect(attempt).toBeDefined();
  const receipt = captureSessionControllerSourceSettlement(params.sourceRef.input);
  let settled = false;
  void receipt.then(() => {
    settled = true;
  });
  const failure = new Error("acknowledgment transport failed");
  acknowledgment.reject(failure);
  await expect(attempt!.acceptance).rejects.toBe(failure);
  await Promise.resolve();
  expect(settled).toBe(false);
  nativeOutcome.resolve({ status: "rejected", reason: "runtime_rejected" });
  await expect(attempt!.outcome).rejects.toBe(failure);
  await receipt;
  expect(settled).toBe(true);
});
