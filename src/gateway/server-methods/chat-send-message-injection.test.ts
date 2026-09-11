/** Covers the injection-start admission fence and steer finalize audit honesty. */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { replyMessageInjectionTargetOperation } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import {
  loadSessionEntry,
  recordSessionParticipant,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
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
vi.mock(import("../../auto-reply/reply/reply-run-registry.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    beginReplyMessageInjectionTarget: vi.fn<typeof actual.beginReplyMessageInjectionTarget>(),
    finalizeReplyMessageInjectionAttempt:
      vi.fn<typeof actual.finalizeReplyMessageInjectionAttempt>(),
  };
});
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(() => null),
  updateSessionEntry: vi.fn(async () => undefined),
  recordSessionParticipant: vi.fn(),
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
vi.mock("../agent-turn/agent-job.js", () => ({
  setGatewayDedupeEntry: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn(() => ({})),
}));
vi.mock("../../auto-reply/command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ senderIsOwner: true })),
}));
vi.mock("../../auto-reply/reply/reply-tool-authority.js", () => ({
  resolveInboundReplyToolAuthorityOverlay: vi.fn(() => ({})),
}));

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
      storePath: "/tmp/nowhere.json",
    },
    startedAt: Date.now(),
    target: {} as ReplyMessageInjectionTarget,
  } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0];
}

function makeFailClosedEntry() {
  return {
    sessionId: "session-1",
    status: "running",
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
    restartRecoveryDeliveryReceiptState: "terminal-pending",
    restartRecoveryDeliveryToolCallId: "message-call-1",
    updatedAt: 1,
  } as never;
}

function makeStarterParams(params?: { entry?: unknown; loadLatest?: unknown }) {
  return {
    target: { runId: "run-1" } as ReplyMessageInjectionTarget,
    request: {
      p: {},
      rawMessage: "steer",
      supportsTaskSuggestions: false,
    },
    session: {
      cfg: {},
      clientRunId: "run-1",
      entry: params?.entry as never,
      sessionKey: "agent:main:dashboard:s",
      storePath: "/tmp/nowhere.json",
    },
    turn: {
      ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
      isInternalTextSlashCommandTurn: false,
      replyOptionImages: [],
      replyOptionMedia: [],
    },
    imageOrder: [],
    userTurnTranscriptRecorder: {},
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof createChatSendMessageInjectionStarter>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it("audits an unconfirmed-transcript steer abort as skipped, not completed", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: {
        status: "accepted",
        result: { transcriptCommit: "unconfirmed", errorMessage: "commit timeout" },
      },
      targetRunId: "run-1",
      aborted: true,
    });
    await finalizeAcceptedChatSendMessageInjection(makeParams());

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply_operation_aborted" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "skipped", options: { reason: "reply_operation_aborted" } },
      }),
    );
  });
});

describe("createChatSendMessageInjectionStarter admission fence", () => {
  it("rejects the injection before queueing when the latest persisted entry fail-closes terminal delivery", () => {
    // A terminal receipt committed after prepareChatSendSession captured its
    // dispatch snapshot. The fence must revalidate at the injection-start
    // boundary — before beginReplyMessageInjectionTarget synchronously queues
    // the steer with the target runtime — so nothing is enqueued and the
    // inbound falls back to follow-up dispatch (#128971).
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "delivered-terminal",
      updatedAt: 2,
    } as never);
    const params = makeStarterParams();
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(loadSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ readConsistency: "latest" }),
    );
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("rejects before queueing when the captured entry itself fail-closes terminal delivery", () => {
    // No reload needed: the entry captured during prepareChatSendSession
    // already records the terminal receipt.
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("follows the latest persisted entry over the stale captured snapshot", () => {
    // The captured snapshot fail-closed after dispatch, but the latest
    // persisted entry is startable again (terminal intent cancelled): the
    // fence must follow the latest state and allow the steer.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      updatedAt: 2,
    } as never);
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("rejects steering when reloading a captured terminal entry fails", () => {
    vi.mocked(loadSessionEntry).mockImplementationOnce(() => {
      throw new Error("store busy");
    });
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("queues the steer when the latest persisted entry is startable", () => {
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams();
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("queues the steer when the latest persisted entry holds only an unrelated historical tombstone", () => {
    // Terminal run ids are accumulated session history; a tombstone from a
    // prior source must not fence the active source into follow-up mode.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryTerminalRunIds: ["source-old"],
      updatedAt: 2,
    } as never);
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams({
      entry: { sessionId: "session-1", status: "running", updatedAt: 1 } as never,
    });
    params.target = {
      [replyMessageInjectionTargetOperation]: {} as unknown as ReplyOperation,
      runId: "run-1",
      sourceTurnId: "source-1",
    };
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("rejects before queueing when the latest persisted entry tombstones the active source turn", () => {
    // The active source turn itself is tombstoned: the steered terminal send
    // would resolve to already-delivered, so the fence must reject.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryTerminalRunIds: ["source-1"],
      updatedAt: 2,
    } as never);
    const params = makeStarterParams();
    params.target = {
      [replyMessageInjectionTargetOperation]: {} as unknown as ReplyOperation,
      runId: "run-1",
      sourceTurnId: "source-1",
    };
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });
});

describe("gateway steer contract after the injection-start fence", () => {
  it("routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued", () => {
    // Mock-gateway contract: the pre-ACK path creates the starter, invokes
    // it synchronously, and hands the inbound to follow-up dispatch whenever
    // no injection attempt exists. A terminal receipt present at the
    // injection-start boundary must yield exactly one delivery path — the
    // follow-up dispatch — and zero runtime queueMessage calls, instead of
    // the old post-enqueue rejection (steer already queued + fallback
    // second dispatch = inbound double delivery).
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      updatedAt: 2,
    } as never);
    const dispatchFollowup = vi.fn();
    const begin = createChatSendMessageInjectionStarter(makeStarterParams());

    const attempt = begin();
    if (attempt) {
      throw new Error("unexpected injection attempt for a fail-closed session");
    }
    dispatchFollowup();

    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(dispatchFollowup).toHaveBeenCalledOnce();
  });
});

describe("createChatSendMessageInjectionStarter", () => {
  beforeEach(() => {
    vi.mocked(beginReplyMessageInjectionTarget).mockImplementation((target) => ({
      targetRunId: target.runId,
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    }));
  });

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
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    onTestFinished(() => operation.complete());
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
      replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey),
      "Expected the running test operation to accept steering",
    );

    return {
      target,
      request: {
        p: { sessionKey, message: rawMessage, idempotencyKey: "steer-input" },
        rawMessage,
        supportsTaskSuggestions: false,
      },
      session: {
        cfg: {},
        entry: undefined,
        sessionKey,
        storePath: "/tmp/nowhere.json",
        clientRunId: "active-run",
      },
      turn: {
        discardUnreferencedMedia: async () => {},
        accountId: undefined,
        ctx: { Provider: "dashboard", Body: params?.body, media: params?.media },
        isInternalTextSlashCommandTurn: params?.isInternalTextSlashCommandTurn ?? false,
        managedMediaApplyMode: "replace-empty",
        queuedFollowupOwnerKey: undefined,
        pluginBoundMediaPromise: Promise.resolve([]),
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

  it("rejects steering when the latest session entry cannot be read", () => {
    const params = makeSteerStarterParams({ body: "follow up after the terminal reply" });
    params.session.entry = {
      sessionId: "steer-test-session",
      updatedAt: 1,
      status: "running",
      restartRecoveryDeliveryRunId: "active-recovery",
      restartRecoveryDeliverySourceRunId: "active-source",
    };
    const start = createChatSendMessageInjectionStarter(params);
    vi.mocked(loadSessionEntry).mockImplementationOnce(() => {
      throw new Error("session database read failed");
    });

    expect(start()).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
  });

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
  ])("retains marker and document text for a $label steer", ({ caption, expectedText }) => {
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
    const durableContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      params.target,
      expectedText,
      expect.objectContaining({ isInboundUserMessage: true }),
    );
    expect(params.turn.ctx).toEqual(durableContext);
  });

  it("keeps the attachment note when document rendering fails", () => {
    const params = makeSteerStarterParams({
      body: "read the attachment",
      media: [{ path: "media://inbound/note.txt", contentType: "text/plain" }],
      documentContext: { status: "failed" },
    });
    const originalContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      params.target,
      "[media attached: media://inbound/note.txt (text/plain)]\n\nread the attachment",
      expect.objectContaining({ isInboundUserMessage: true }),
    );
    expect(params.turn.ctx).toEqual(originalContext);
  });

  it("keeps the base text untouched when no document context was rendered", () => {
    createChatSendMessageInjectionStarter(makeSteerStarterParams({ body: "plain steer" }))();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "plain steer",
      expect.anything(),
    );
  });

  it("merges extracted page images after the prepared inbound images", () => {
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
    const durableContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "[media attached: 2 files]\n" +
        "[media attached 1/2: media://inbound/photo.png (image/png)]\n" +
        "[media attached 2/2: media://inbound/scan.pdf (application/pdf)]\n\n" +
        "see attached\n\n[PDF content rendered to images]",
      expect.objectContaining({
        images: [
          { type: "image", data: "inbound-photo", mimeType: "image/png", sourceIndex: 0 },
          { type: "image", data: "page-1", mimeType: "image/png", sourceIndex: 1 },
          { type: "image", data: "page-2", mimeType: "image/png", sourceIndex: 1 },
        ],
      }),
    );
    expect(params.turn.ctx).toEqual(durableContext);
  });

  it("injects extracted page images when the steer carries no inbound images", () => {
    createChatSendMessageInjectionStarter(
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

  it("returns undefined for internal slash-command turns even with a target", () => {
    expect(
      createChatSendMessageInjectionStarter(
        makeSteerStarterParams({ isInternalTextSlashCommandTurn: true }),
      )(),
    ).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
  });
});
