import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import { revalidateChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import {
  beginModelCatalogRead,
  invalidateModelCatalogCache,
  publishModelCatalogResult,
} from "../../lib/model-catalog-cache.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import { sessionListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { historyBudget, makeChatHost, requestCalls } from "./chat-host.test-support.ts";
import { removeQueuedMessage, keepVolatileQueuedMessage } from "./chat-queue.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { requestChatSend } from "./chat-send-request.ts";
import { startupAdmissionResponse } from "./chat-startup-response.test-support.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createChatState } from "./chat-state-controller.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  applySelectedChatAgent,
  applyChatModelCatalogSnapshot,
  refreshChatMetadata,
  refreshChatModelCatalogOnDemand,
  refreshChatModelAuthStatus,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import {
  createSessionEventState,
  emitGatewayEvent,
  renderedTranscript,
} from "./chat-state.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";
import {
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  updateQueuedMessageEdit,
} from "./queued-message-edit.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { createHost as createToolStreamHost } from "./tool-stream.test-helpers.ts";

function textMessage(text: string, role = "assistant") {
  return { role, content: [{ type: "text", text }] };
}

function chatEvent(
  state: ChatPageHost,
  runId: string,
  phase: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  emitGatewayEvent(state, "chat", {
    sessionKey: state.sessionKey,
    runId,
    state: phase,
    message: textMessage(text),
    ...extra,
  });
}

function agentEvent(
  state: ChatPageHost,
  runId: string,
  seq: number,
  stream: string,
  data: Record<string, unknown>,
  ts = seq,
) {
  emitGatewayEvent(state, "agent", { sessionKey: state.sessionKey, runId, seq, ts, stream, data });
}

function persistMessage(
  state: ChatPageHost,
  messageId: string,
  messageSeq: number,
  message: unknown,
  extra: Record<string, unknown> = {},
) {
  emitGatewayEvent(state, "session.message", {
    sessionKey: state.sessionKey,
    messageId,
    messageSeq,
    message,
    ...extra,
  });
}

function clearStream(state: ChatPageHost, runId: string) {
  emitGatewayEvent(state, "chat", {
    sessionKey: state.sessionKey,
    runId,
    state: "delta",
    deltaText: "",
    replace: true,
    message: { role: "assistant", content: [] },
  });
}

function captureAnimationFrames() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancelFrame = vi
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((id) => frames.delete(id));
  return { frames, cancelFrame };
}

beforeEach(() => {
  vi.spyOn(assistantIdentity, "loadLocalAssistantIdentity").mockReturnValue({
    avatar: "data:image/png;base64,bG9jYWw=",
  });
});

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canonical session message recovery", () => {
  it("reconciles live approval events for the selected session", () => {
    const { state } = createSessionEventState();
    const approval = {
      id: "plugin:approval-live",
      status: "pending" as const,
      presentation: {
        kind: "plugin" as const,
        title: "Run Codex execution on node",
        description: "Allows node account access",
        severity: "critical" as const,
        pluginId: "codex",
        agentId: "main",
        allowedDecisions: ["allow-once", "deny"] as const,
      },
      urlPath: "/approve/plugin%3Aapproval-live",
      createdAtMs: 1_000,
      expiresAtMs: 10_000,
    };
    const deliver = (
      sessionKey: string,
      updatedAtMs: number,
      terminal = false,
      sourceSessionKey?: string,
    ) =>
      emitGatewayEvent(state, "session.approval", {
        sessionKey,
        ...(sourceSessionKey ? { sourceSessionKey } : {}),
        phase: terminal ? "terminal" : "pending",
        updatedAtMs,
        approval: terminal
          ? {
              ...approval,
              status: "denied",
              decision: "deny",
              reason: "user",
              resolvedAtMs: updatedAtMs,
            }
          : approval,
      });
    deliver("agent:main:main", 1_000, false, "agent:main:cloud-child");
    expect(state.chatSessionApprovalQueue).toEqual([
      expect.objectContaining({ id: approval.id, sourceSessionKey: "agent:main:cloud-child" }),
    ]);
    deliver("agent:main:main", 2_000, true, "agent:main:cloud-child");
    expect(state.chatSessionApprovalQueue).toEqual([]);
    state.sessionKey = "global";
    state.assistantAgentId = "research";
    deliver("agent:research:global", 3_000);
    expect(state.chatSessionApprovalQueue).toEqual([
      expect.objectContaining({
        id: approval.id,
        request: expect.objectContaining({ sessionKey: "global" }),
      }),
    ]);
    deliver("agent:main:global", 4_000, true);
    expect(state.chatSessionApprovalQueue).toHaveLength(1);
    deliver("agent:research:global", 4_000, true);
    expect(state.chatSessionApprovalQueue).toHaveLength(0);
  });

  it.each([undefined, 3])(
    "admits incomplete imported identity only with persisted sequence %s",
    (seq) => {
      const { state } = createSessionEventState({ connected: false });
      const identity = {
        importedFrom: "claude-cli",
        externalId: "source-local-user",
        ...(seq === undefined ? {} : { seq }),
      };
      persistMessage(state, "conflicting-native-envelope", 90, {
        ...textMessage("Imported prompt", "user"),
        __openclaw: identity,
      });
      if (seq === undefined) {
        expect(state.chatMessages).toEqual([]);
      } else {
        expect(state.chatMessages).toHaveLength(1);
        expect(state.chatMessages[0]).toMatchObject({ __openclaw: identity });
      }
    },
  );

  it.each(["active-run", undefined])(
    "retires durable mirrored commentary owned by %s",
    (ownerRunId) => {
      const runId = "active-run";
      const itemId = "commentary-1";
      const text = "Checking the workspace.";
      const { state } = createSessionEventState({
        connected: false,

        chatRunId: runId,

        chatStreamSegments: [{ text, ts: 1, runId, itemId }],
      });

      applySessionMessagePayload(
        state,
        {
          sessionKey: state.sessionKey,
          messageId: "commentary-message-1",
          messageSeq: 1,
          message: {
            ...textMessage(text),
            idempotencyKey: `codex-app-server:thread:turn:commentary:${itemId}`,
            __openclaw: {
              mirrorOrigin: "codex-app-server",
              ...(ownerRunId ? { runId: ownerRunId } : {}),
            },
            timestamp: 1,
            openclawStreamFallback: {
              replacementText: text,
              source: "segment",
              itemId,
            },
          },
        },
        true,
        { kind: "history-delta" },
      );

      expect(state.chatStreamSegments).toEqual([]);
      expect(renderedTranscript(state)).toEqual([{ role: "assistant", text }]);
    },
  );

  it("retires selected-run transient activity when its durable terminal arrives", () => {
    const runId = "active-run";
    const siblingRunId = "sibling-run";
    const activityKey = (owner: string) => "tool:" + JSON.stringify([owner, "tool"]) + ":result";
    const selected = { text: "Commentary", ts: 1, runId, itemId: "commentary-1" };
    const sibling = {
      text: "Sibling commentary",
      ts: 1,
      runId: siblingRunId,
      itemId: "commentary-2",
    };
    const { state } = createSessionEventState({
      connected: false,
      chatRunId: runId,
      chatStream: "The durable terminal reply.",
      chatStreamStartedAt: 1,
      chatStreamSegments: [selected, sibling],
      activityEventSeqById: new Map([
        [activityKey(runId), 2],
        [activityKey(siblingRunId), 2],
      ]),
    });
    applySessionMessagePayload(
      state,
      {
        sessionKey: state.sessionKey,
        runId,
        messageId: "terminal-message",
        messageSeq: 2,
        message: { ...textMessage("The durable terminal reply."), timestamp: 2 },
      },
      false,
      { kind: "live", activeRunId: runId },
    );
    expect(state.chatMessages.map(extractText)).toEqual(["The durable terminal reply."]);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toEqual([sibling]);
    expect([...(state.activityEventSeqById?.keys() ?? [])]).toEqual([activityKey(siblingRunId)]);
  });

  it.each([false, true])(
    "keeps accepted steers between saved output and whole later messages (later commentary=%s)",
    (laterCommentary) => {
      const activeRunId = "active-run";
      const steerRunId = "steer-request";
      const originalPrompt = {
        ...textMessage("Original prompt", "user"),
        timestamp: 100,
        __openclaw: {
          id: "original-user",
          idempotencyKey: `${activeRunId}:user`,
          seq: 1,
        },
      };
      const { state } = createSessionEventState({
        connected: false,
        chatMessages: [originalPrompt],
        chatRunId: activeRunId,
      });
      chatEvent(state, activeRunId, "delta", "Before steer.", { deltaText: "Before steer." });
      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Original prompt" },
        { role: "assistant", text: "Before steer." },
      ]);
      expect(state.chatRunId).toBe(activeRunId);
      expect(state.chatQueue).toEqual([]);
      if (laterCommentary) {
        // Embedded turns commit the prior assistant before admitting a durable steer.
        clearStream(state, activeRunId);
        persistMessage(
          state,
          "saved-before-steer",
          2,
          {
            ...textMessage("Before steer."),
            timestamp: 101,
            __openclaw: { id: "saved-before-steer", seq: 2, runId: activeRunId },
          },
          { runId: activeRunId, hasActiveRun: true },
        );
      }
      reduceChatSessionProjection(state, {
        type: "sendPending",
        runId: steerRunId,
        message: {
          ...textMessage("Steer prompt", "user"),
          timestamp: 50,
          __openclaw: { idempotencyKey: `${steerRunId}:user` },
        },
      });
      state.chatRunId = steerRunId;

      const steerEvent = {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          clientRunId: activeRunId,
          hasActiveRun: true,
          messageId: "persisted-steer-user",
          messageSeq: laterCommentary ? 3 : 2,
          message: {
            ...textMessage("Steer prompt", "user"),
            timestamp: 50,
            __openclaw: {
              id: "persisted-steer-user",
              idempotencyKey: `${steerRunId}:user`,
              seq: laterCommentary ? 3 : 2,
              steerTargetRunId: activeRunId,
            },
          },
        },
      } satisfies Parameters<typeof handlePageGatewayEvent>[1];
      handlePageGatewayEvent(state, steerEvent);
      expect(state.chatRunId).toBe(activeRunId);
      const segmentsAfterRequestBoundary = state.chatStreamSegments;
      expect(
        state.chatMessages.filter((message) => extractText(message) === "Steer prompt"),
      ).toHaveLength(1);
      chatEvent(
        state,
        activeRunId,
        "delta",
        laterCommentary ? "After steer." : "Before steer. After steer.",
        { deltaText: laterCommentary ? "After steer." : " After steer." },
      );

      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Original prompt" },
        ...(laterCommentary ? [{ role: "assistant", text: "Before steer." }] : []),
        { role: "user", text: "Steer prompt" },
        {
          role: "assistant",
          text: laterCommentary ? "After steer." : "Before steer. After steer.",
        },
      ]);

      handlePageGatewayEvent(state, steerEvent);
      expect(state.chatStreamSegments).toBe(segmentsAfterRequestBoundary);

      if (laterCommentary) {
        clearStream(state, activeRunId);
        agentEvent(
          state,
          activeRunId,
          1,
          "item",
          {
            kind: "preamble",
            itemId: "after-steer-commentary",
            progressText: "After steer.",
          },
          101,
        );
        persistMessage(
          state,
          "saved-commentary",
          4,
          {
            ...textMessage("After steer."),
            openclawStreamFallback: { source: "segment", itemId: "after-steer-commentary" },
            __openclaw: { id: "saved-commentary", seq: 4, runId: activeRunId },
          },
          { runId: activeRunId, hasActiveRun: true },
        );
      }
      const terminalText = laterCommentary
        ? "Before steer. Final unseen suffix."
        : "Before steer. After steer. Final unseen suffix.";
      const terminalMessage = textMessage(terminalText);
      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "final",
        message: terminalMessage,
      });
      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Original prompt" },
        ...(laterCommentary ? [{ role: "assistant", text: "Before steer." }] : []),
        { role: "user", text: "Steer prompt" },
        ...(laterCommentary ? [{ role: "assistant", text: "After steer." }] : []),
        { role: "assistant", text: terminalText },
      ]);
      expect(terminalMessage.content).toEqual([{ type: "text", text: terminalText }]);
    },
  );

  it("keeps the owned local prompt before an early durable reply after placement abandonment", () => {
    const runId = "local-placement-run-2";
    const promptText = "Resume locally 2.";
    const replyText = "Exactly one local Gateway response 2.";
    const originalPrompt = {
      ...textMessage("Continue interrupted work 2.", "user"),
      timestamp: 1_700_000_000_000,
      __openclaw: {
        id: "placement-user-2",
        idempotencyKey: "abandoned-placement-run-2:user",
        seq: 1,
      },
    };
    const abandonedPartial = {
      ...textMessage("Gateway-synced device response 2."),
      timestamp: 1_700_000_000_001,
      __openclaw: { id: "placement-aborted-assistant-2", seq: 2 },
      idempotencyKey: "abandoned-placement-run-2:assistant",
      openclawAbort: {
        aborted: true,
        origin: "placement-abandon",
        runId: "abandoned-placement-run-2",
      },
      stopReason: "stop",
    };
    const localUser = {
      ...textMessage(promptText, "user"),
      timestamp: 1_700_000_000_002,
      __openclaw: { id: "placement-local-user-2", idempotencyKey: `${runId}:user`, seq: 3 },
    };
    const localFinalIdentity = { id: "placement-local-final-2", seq: 4 };
    const localFinal = {
      ...textMessage(replyText),
      timestamp: 1_700_000_000_003,
      __openclaw: localFinalIdentity,
    };
    // Begin at the settled abandonment snapshot; the new prompt still belongs
    // to the outbox, not history. Keep the original fixture's Gateway timestamps.
    const { state, request } = createSessionEventState({
      chatMessages: [originalPrompt, abandonedPartial],
      chatRunId: runId,
    });
    keepVolatileQueuedMessage(state, state.sessionKey, {
      id: "placement-local-send-2",
      text: promptText,
      createdAt: Date.now(),
      sendState: "sending",
      sendRunId: runId,
      sendAttempts: 1,
    });
    const expected = [originalPrompt, abandonedPartial, localUser, localFinal].map((message) => ({
      role: message.role,
      text: extractText(message),
    }));

    try {
      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId,
        seq: 5,
        state: "delta",
        deltaText: replyText,
        message: {
          role: "assistant",
          content: localFinal.content,
          timestamp: localFinal.timestamp,
        },
      });
      expect(renderedTranscript(state)).toEqual(expected);

      // setHistoryMessages in the browser fixture changes only future responses;
      // it does not deliver a user persistence event before this assistant row.
      request.mockResolvedValue({
        messages: [originalPrompt, abandonedPartial, localUser, localFinal],
        sessionId: state.currentSessionId,
      });
      emitGatewayEvent(state, "chat", {
        sessionKey: state.sessionKey,
        runId,
        seq: 5,
        state: "delta",
        replace: true,
        deltaText: "",
        message: { role: "assistant", content: [] },
      });
      persistMessage(state, localFinalIdentity.id, localFinalIdentity.seq, localFinal, {
        runId,
        activeRunIds: null,
        hasActiveRun: true,
      });
      expect(state.chatMessages.map(extractText)).toEqual([
        extractText(originalPrompt),
        extractText(abandonedPartial),
        replyText,
      ]);
      expect(request).not.toHaveBeenCalled();
      // Full terminal/outbox retirement and reload use the real browser lifecycle
      // in session-placement.move.e2e.test.ts; this boundary is before either.
      expect(renderedTranscript(state)).toEqual(expected);
    } finally {
      removeQueuedMessage(state, "placement-local-send-2");
    }
  });

  it.each([
    { name: "an unowned legacy", runId: undefined },
    { name: "an exactly producer-owned", runId: "older-run" },
  ])("never lets $name delayed older assistant row displace a newer run's reply", ({ runId }) => {
    const olderReply = {
      ...textMessage("Answer from the older run."),
      __openclaw: { id: "older-reply", seq: 2 },
    };
    const { state } = createSessionEventState({
      chatRunId: "newer-run",
    });
    chatEvent(state, "newer-run", "final", "Answer from the newer run.");
    expect(state.chatRunId).toBeNull();

    // The terminal tombstone outlives its run, so a late row carrying some
    // other reply must not borrow that run's ownership and replace it.
    persistMessage(state, "older-reply", 2, olderReply, {
      ...(runId ? { runId } : {}),
      hasActiveRun: false,
    });

    expect(state.chatMessages.map((message) => extractText(message))).toEqual([
      "Answer from the newer run.",
    ]);
  });

  it("does not rebind an unrelated run from a persisted steer", () => {
    const { state } = createSessionEventState({
      connected: false,

      chatRunId: "run-c",
      chatStream: "Run C",
    });

    persistMessage(
      state,
      "steer-b",
      1,
      {
        role: "user",
        content: "Steer A",
        __openclaw: {
          id: "steer-b",
          idempotencyKey: "run-b:user",
          seq: 1,
          steerTargetRunId: "run-a",
        },
      },
      { clientRunId: "run-b", hasActiveRun: true },
    );

    expect(state.chatRunId).toBe("run-c");
    expect(state.chatStream).toBe("Run C");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("coalesces live peers into one frame and one fresh read after stale history", async () => {
    let renderFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      renderFrame = callback;
      return 1;
    });
    const { promise: history, resolve: resolveHistory } = createDeferred<ChatHistoryResult>();
    const messages = ["web", "tui", "cli"].map((client, index) =>
      Object.assign(textMessage("shared prompt", "user"), {
        __openclaw: {
          id: `canonical-${client}-same-text`,
          idempotencyKey: `${client}-same-text-run:user`,
          seq: index + 1,
        },
      }),
    );
    const snapshot: ChatHistoryResult = { messages, sessionId: "selected-session" };
    const { request, state } = createSessionEventState({ chatDisplayedLeafEntryId: undefined });
    const publication = vi.fn();
    onTestFinished(chatRunPresentation(state).subscribe(publication));
    request.mockReturnValueOnce(history).mockResolvedValue(snapshot);

    for (const [index, message] of messages.entries()) {
      persistMessage(state, `conflicting-envelope-${index}`, 100 + index, message);

      expect(state.chatMessages).toHaveLength(index + 1);
      expect(publication).not.toHaveBeenCalled();
    }
    renderFrame?.(0);
    expect(publication).toHaveBeenCalledOnce();

    expect(request).toHaveBeenCalledOnce();
    const refreshed = loadChatHistory(state);
    resolveHistory({ ...snapshot, messages: [] });
    await refreshed;

    expect(state.chatLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toMatchObject([
      { __openclaw: { id: "canonical-web-same-text", seq: 1 } },
      { __openclaw: { id: "canonical-tui-same-text", seq: 2 } },
      { __openclaw: { id: "canonical-cli-same-text", seq: 3 } },
    ]);
  });

  it("drops pre-reset live and pending messages before accepting a new session turn", () => {
    const retireSessionCompanion = vi.fn();
    const pendingUser = {
      ...textMessage("Pending before reset", "user"),
      __openclaw: { idempotencyKey: "pre-reset-pending:user" },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [pendingUser],
    });
    (
      state as ChatPageHost & { retireSessionCompanion: typeof retireSessionCompanion }
    ).retireSessionCompanion = retireSessionCompanion;
    const deliverUser = (id: string, text: string) =>
      emitGatewayEvent(state, "session.message", {
        sessionKey: state.sessionKey,
        message: {
          ...textMessage(text, "user"),
          __openclaw: { id, idempotencyKey: `${id}:user`, seq: 1 },
        },
      });

    deliverUser("pre-reset-live", "Live before reset");
    expect(state.chatMessages).toHaveLength(2);

    emitGatewayEvent(state, "sessions.changed", {
      sessionKey: state.sessionKey,
      agentId: "main",
      reason: "reset",
    });
    expect(state.chatMessages).toEqual([]);
    expect(retireSessionCompanion).toHaveBeenCalledExactlyOnceWith(state.sessionKey, "main");

    deliverUser("post-reset-live", "Live after reset");
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({
      __openclaw: { id: "post-reset-live", seq: 1 },
    });
  });

  it("does not clear the selected transcript when another agent resets", () => {
    const retireSessionCompanion = vi.fn();
    const selectedUser = {
      ...textMessage("Keep this agent's conversation", "user"),
      __openclaw: { id: "selected-user", seq: 1 },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [selectedUser],
    });
    (
      state as ChatPageHost & { retireSessionCompanion: typeof retireSessionCompanion }
    ).retireSessionCompanion = retireSessionCompanion;

    emitGatewayEvent(state, "sessions.changed", {
      sessionKey: "agent:other:main",
      agentId: "other",
      reason: "reset",
    });

    expect(state.chatMessages).toEqual([selectedUser]);
    expect(retireSessionCompanion).toHaveBeenCalledExactlyOnceWith("agent:other:main", "other");
  });

  it.each([
    { sessionKey: "agent:main:main", agentId: "main", reason: "branch-switch", retire: true },
    { sessionKey: "agent:main:main", agentId: "main", reason: "send", retire: false },
    { sessionKey: "agent:other:main", agentId: "other", reason: "rewind", retire: false },
  ])("updates checkout presentation for $reason/$sessionKey", ({ retire, ...payload }) => {
    const oldBranches = [
      { leafEntryId: "old-leaf", headline: "Old checkout", messageCount: 1, active: true },
    ];
    const { state } = createSessionEventState({
      chatBranches: oldBranches,
      chatBranchesConnectionEpoch: 1,
      chatBranchesSessionKey: "agent:main:main",
    });
    const listBranches = vi.mocked(state.sessions.listBranches);
    if (retire) {
      listBranches.mockImplementation(() => new Promise<never>(() => {}));
    }
    emitGatewayEvent(state, "sessions.changed", payload);
    if (retire) {
      expect(state.chatBranches).toEqual([]);
      expect(state.chatBranchesSessionKey).toBeNull();
      expect(listBranches).toHaveBeenCalled();
    } else {
      expect(state.chatBranches).toBe(oldBranches);
      expect(state.chatBranchesSessionKey).toBe("agent:main:main");
    }
  });

  it("keeps the routed row when a hidden pane observes its archive first", async () => {
    const archivedKey = "agent:main:dashboard:archived";
    const client = createTestGatewayClient(async () =>
      sessionsResult(
        [
          {
            key: archivedKey,
            kind: "direct",
            archived: false,
            derivedTitle: "Archived title",
            updatedAt: 1,
          },
        ],
        1,
      ),
    );
    const { gateway, emitEvent } = createGatewayHarness(client);
    gateway.snapshot.sessionKey = archivedKey;
    const sessions = createTestSessionCapability(gateway);
    const { state } = createSessionEventState({ sessions });
    const delivered = vi.fn();
    const hidden = sessions.observeRow({ key: state.sessionKey, agentId: "main" }, () => {}, {
      onEvent: (event, result) => {
        delivered(event, result);
        handlePageGatewayEvent(state, event, () => false, result);
      },
    });
    try {
      await sessions.refresh({ agentId: "main", force: true });
      expect(sessions.state.result?.sessions).toHaveLength(1);
      const event = {
        type: "event" as const,
        event: "sessions.changed",
        payload: { key: archivedKey, sessionKey: archivedKey, archived: true, reason: "update" },
      };
      emitEvent(event);

      expect(delivered).toHaveBeenCalledExactlyOnceWith(event, { applied: false });
      expect(state.sessions.state.result?.sessions).toEqual([
        expect.objectContaining({
          key: archivedKey,
          archived: true,
          derivedTitle: "Archived title",
        }),
      ]);
    } finally {
      hidden.dispose();
      sessions.dispose();
    }
  });

  it.each([
    {
      name: "disconnected pending transcript",
      connected: false,
      otherSession: false,
      identified: false,
    },
    { name: "selected history", connected: true, otherSession: false, identified: false },
    { name: "another session", connected: true, otherSession: true, identified: false },
    { name: "already identified message", connected: true, otherSession: false, identified: true },
  ])("handles message invalidation for $name", async ({ connected, otherSession, identified }) => {
    const selectedUser = {
      ...textMessage("Keep this pending transcript", "user"),
      __openclaw: { idempotencyKey: "still-pending:user" },
    };
    const { request, state } = createSessionEventState({
      connected,
      ...(!connected ? { chatMessages: [selectedUser] } : {}),
      ...(!otherSession && !identified && connected ? { chatRunId: "active-run" } : {}),
    });
    emitGatewayEvent(state, "sessions.changed", {
      sessionKey: otherSession ? "agent:other:main" : state.sessionKey,
      agentId: otherSession ? "other" : "main",
      phase: "message",
      ...(identified ? { messageId: "already-authoritative-user", messageSeq: 3 } : {}),
    });
    if (!connected) {
      expect(state.chatMessages).toEqual([selectedUser]);
    } else if (otherSession || identified) {
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          { sessionKey: state.sessionKey, knownState: {}, ...historyBudget },
          { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
        ),
      );
      expect(state.chatRunId).toBe("active-run");
    }
  });

  it("defers branch hydration when a session reconciliation finishes after the pane hides", async () => {
    const refreshFinished = createDeferred();
    let presented = true;
    const listBranches = vi.fn().mockResolvedValue([]);
    const { request, state } = createSessionEventState({
      chatRunId: "run-1",
      chatStream: "Finishing",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      },
    });
    state.sessions = {
      ...state.sessions,
      listBranches,
      refresh: vi.fn(async () => {
        await refreshFinished.promise;
        state.sessionsResult = sessionListResult(2, [
          {
            key: state.sessionKey,
            kind: "direct",
            hasActiveRun: false,
            status: "done",
            updatedAt: 2,
          },
        ]);
      }),
    };

    handlePageGatewayEvent(
      state,
      {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          runId: "run-1",
          messageId: "terminal-message",
          messageSeq: 2,
          message: { ...textMessage("Finished"), __openclaw: { id: "terminal-message", seq: 2 } },
        },
      },
      () => presented,
      { applied: false },
    );
    presented = false;
    refreshFinished.resolve();

    await vi.waitFor(() => expect(state.chatRunId).toBeNull());
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(listBranches).not.toHaveBeenCalled();
  });
});

describe("chat state render lifecycle", () => {
  it("publishes activity for stream boundaries without republishing continuing text", () => {
    const changed = vi.fn();
    const controller = createChatState<ChatPageHost>({ awaitDomCommit: async () => true }, changed);
    onTestFinished(controller.dispose);
    const state = createPageState(
      createChatPageStateContext(),
      controller.createRenderLifecycle(),
      { dispatchEvent: () => true },
    );
    controller.attach(state);
    changed.mockClear();
    const run = chatRunPresentation(state);

    run.batch(() => (state.chatStream = "First"));
    expect(changed).toHaveBeenCalledOnce();
    changed.mockClear();

    run.batch(() => (state.chatStream = "First and second"));
    expect(state.chatStream).toBe("First and second");
    expect(changed).not.toHaveBeenCalled();

    run.batch(() => (state.chatStream = null));
    expect(changed).toHaveBeenCalledOnce();
  });

  it("publishes queued-edit retention without rendering and preserves the edit token", () => {
    const changed = vi.fn();
    const awaitDomCommit = vi.fn(async () => true);
    const controller = createChatState<ChatPageHost>({ awaitDomCommit }, changed);
    onTestFinished(controller.dispose);
    const state = createPageState(
      createChatPageStateContext(),
      controller.createRenderLifecycle(),
      {
        sessionKey: "agent:main:queued-edit",
        dispatchEvent: () => true,
      },
    );
    state.client = createTestGatewayClient(vi.fn());
    state.connected = true;
    controller.attach(state);
    keepVolatileQueuedMessage(state, state.sessionKey, {
      id: "retained-edit",
      text: "Original input",
      createdAt: 1,
      sendState: "waiting-idle",
    });
    changed.mockClear();

    expect(beginQueuedMessageEdit(state, "retained-edit")).toBe("started");
    const token = state.chatQueuedEdit;
    expect(changed).toHaveBeenCalledOnce();
    expect(updateQueuedMessageEdit(state, "Corrected input")).toBe(true);
    expect(state.chatQueuedEdit).toBe(token);
    expect(token?.draftText).toBe("Corrected input");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(cancelQueuedMessageEdit(state)).toBe(true);
    expect(state.chatQueuedEdit).toBeNull();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(awaitDomCommit).not.toHaveBeenCalled();

    controller.dispose();
    changed.mockClear();
    expect(beginQueuedMessageEdit(state, "retained-edit")).toBe("started");
    expect(changed).not.toHaveBeenCalled();
  });

  it("publishes a cleared draft before an offline Stop waits for reconnect", async () => {
    const controller = createChatState<ChatPageHost>({ awaitDomCommit: async () => true });
    onTestFinished(controller.dispose);
    const state = createPageState(
      createChatPageStateContext(),
      controller.createRenderLifecycle(),
      {
        sessionKey: "agent:main:offline-stop",
        dispatchEvent: () => true,
      },
    );
    state.client = createTestGatewayClient(vi.fn());
    state.connected = false;
    state.chatRunId = "offline-run";
    state.chatMessage = "Unsent input";
    state.chatReplyTarget = { messageId: "prior-message", text: "Earlier input" };
    controller.attach(state);
    const drafts: string[] = [];
    onTestFinished(
      controller.composerDraft.subscribe(() => drafts.push(controller.composerDraft.read().draft)),
    );

    await state.handleAbortChat();

    expect(drafts).toEqual([""]);
    expect(state.chatReplyTarget).toBeNull();
    expect(state.pendingAbort?.runId).toBe("offline-run");
  });

  it("publishes a pending run projection when an unrelated pane commit consumes its frame", () => {
    const { frames } = captureAnimationFrames();
    const awaitDomCommit = vi.fn(async () => true);
    const controller = createChatState<ChatPageHost>({
      awaitDomCommit,
    });
    let state: ChatPageHost;
    const rendered: (string | null)[] = [];
    const queueLengths: number[] = [];
    const dispose = createRoot((stop) => {
      state = createPageState(createChatPageStateContext(), controller.createRenderLifecycle(), {
        dispatchEvent: () => true,
      });
      state.client = createTestGatewayClient(vi.fn());
      controller.attach(state);
      createEffect(
        () => state.chatStream,
        (stream) => {
          rendered.push(stream);
        },
      );
      createEffect(
        () => state.chatQueue.length,
        (length) => {
          queueLengths.push(length);
        },
      );
      return stop;
    });
    onTestFinished(() => {
      controller.dispose();
      dispose();
    });
    flush();
    awaitDomCommit.mockClear();
    chatRunPresentation(state!).batch(
      () => (state!.chatStream = "queued stream"),
      "animation-frame",
    );
    expect(frames.size).toBe(1);
    controller.publishPendingRunState();
    controller.captureRenderChanges();
    flush();
    expect(frames.size).toBe(0);
    expect(rendered).toEqual([null, "queued stream"]);
    keepVolatileQueuedMessage(state!, state!.sessionKey, {
      id: "run-and-outbox-publication",
      text: "Keep this queued input",
      createdAt: 1,
      sendState: "held",
    });
    expect(state!.chatQueue).toHaveLength(1);
    flush();
    expect(queueLengths).toEqual([0, 1]);
    removeQueuedMessage(state!, "run-and-outbox-publication");
    flush();
    expect(queueLengths).toEqual([0, 1, 0]);
    expect(rendered).toEqual([null, "queued stream"]);
    expect(awaitDomCommit).not.toHaveBeenCalled();
  });

  it("publishes run fields once per frame while preserving synchronous state and terminal ordering", () => {
    const { frames } = captureAnimationFrames();
    const rendered: Array<{ stream: string | null; run: string | null }> = [];
    const { state, dispose } = createRoot((stop) => {
      const createdState = createPageState(
        createChatPageStateContext(),
        { afterCommit: () => () => {} },
        { dispatchEvent: () => true },
      );
      createdState.chatRunId = "run";
      createEffect(
        () => ({ stream: createdState.chatStream, run: createdState.chatRunId }),
        (value) => {
          rendered.push(value);
        },
      );
      return { state: createdState, dispose: stop };
    });
    onTestFinished(dispose);
    flush();
    for (const text of ["A", "AB", "ABC"]) {
      chatRunPresentation(state).batch(() => {
        state.chatStream = text;
      }, "animation-frame");
      expect(state.chatStream).toBe(text);
      flush();
    }
    expect(frames.size).toBe(1);
    expect(rendered).toEqual([{ stream: null, run: "run" }]);
    const queued = frames.get(1)!;
    queued(0);
    frames.delete(1);
    flush();
    expect(rendered.at(-1)).toEqual({ stream: "ABC", run: "run" });
    state.chatMessage = "typing leaves the transcript alone";
    flush();
    expect(rendered).toHaveLength(2);
    chatRunPresentation(state).batch(() => {
      state.chatStream = "ABCD";
    }, "animation-frame");
    const superseded = frames.get(2)!;
    chatRunPresentation(state).batch(() => {
      state.chatStream = null;
      state.chatRunId = null;
    });
    flush();
    superseded(0);
    flush();
    expect(frames.size).toBe(0);
    expect(rendered).toHaveLength(3);
    expect(rendered.at(-1)).toEqual({ stream: null, run: null });
  });

  it("publishes run activity without requesting a DOM commit and releases replaced pane subscriptions", () => {
    const activity = vi.fn();
    const awaitDomCommit = vi.fn(async () => true);
    const controller = createChatState<ChatPageHost>({ awaitDomCommit }, activity);
    onTestFinished(controller.dispose);
    const makeState = () =>
      createPageState(createChatPageStateContext(), controller.createRenderLifecycle(), {
        dispatchEvent: () => true,
      });
    const first = makeState();
    controller.attach(first);
    activity.mockClear();
    awaitDomCommit.mockClear();
    chatRunPresentation(first).batch(() => {
      first.chatRunId = "live-run";
      first.chatStream = "working";
    });
    expect(activity).toHaveBeenCalledOnce();
    expect(awaitDomCommit).not.toHaveBeenCalled();
    const replacement = makeState();
    controller.attach(replacement);
    activity.mockClear();
    first.chatRunId = null;
    expect(activity).not.toHaveBeenCalled();
    replacement.chatRunId = "replacement-run";
    expect(activity).toHaveBeenCalledOnce();
    controller.dispose();
    activity.mockClear();
    replacement.chatRunId = null;
    expect(activity).not.toHaveBeenCalled();
  });

  function createObserverState(
    overrides: Partial<Record<keyof ChatPageHost, unknown>> & { publication?: () => void } = {},
  ) {
    const { publication = vi.fn<() => void>(), ...stateOverrides } = overrides;
    const state = {
      sessionKey: "agent:main:current",
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: null,
      chatMessages: [],
      observerDigest: null,
      ...stateOverrides,
    } as unknown as ChatPageHost;
    onTestFinished(chatRunPresentation(state).subscribe(publication));
    return state;
  }

  function createRenderer(
    overrides: Partial<Parameters<typeof createChatState<ChatPageHost>>[0]> = {},
  ) {
    return { awaitDomCommit: async () => true, ...overrides };
  }

  function createOwner(renderer: Parameters<typeof createChatState<ChatPageHost>>[0]) {
    const controller = createChatState<ChatPageHost>(renderer);
    onTestFinished(controller.dispose);
    return { controller, dispose: controller.dispose };
  }

  function createInputHistoryKey(selectionStart: number, selectionEnd: number) {
    return {
      key: "ArrowUp" as const,
      selectionStart,
      selectionEnd,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    };
  }

  function createStreamEventState(
    overrides: Partial<ChatPageHost> & { publication?: () => void } = {},
  ) {
    const { publication = vi.fn<() => void>(), ...stateOverrides } = overrides;
    const state = {
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatRunId: "run-1",
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamStartedAt: 1,
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      sessionKey: "main",
      ...stateOverrides,
    } as unknown as ChatPageHost;
    onTestFinished(chatRunPresentation(state).subscribe(publication));
    return state;
  }

  it.each(["foreground", "session row"])(
    "admits observer digests only for the %s active run",
    (owner) => {
      const projectedDigest = {
        sessionKey: "agent:main:current",
        runId: "r1",
        revision: 1,
        updatedAt: 1_000,
        headline: "Projected current status",
        health: "on-track" as const,
      };
      const publication = vi.fn();
      const state = createObserverState({
        sessionKey: projectedDigest.sessionKey,
        observerDigest: projectedDigest,
        ...(owner === "foreground"
          ? { chatRunId: "r1" }
          : {
              sessionsResult: {
                sessions: [
                  {
                    key: projectedDigest.sessionKey,
                    hasActiveRun: true,
                    activeRunIds: ["r1"],
                  },
                ],
              },
            }),
        publication,
      });
      const observerEvent = (runId?: string) =>
        ({
          type: "event" as const,
          event: "session.observer",
          payload: {
            sessionKey: projectedDigest.sessionKey,
            ...(runId ? { runId } : {}),
            revision: 2,
            updatedAt: 2_000,
            headline: `Live status ${runId ?? "without run"}`,
            health: "grinding",
          },
        }) satisfies Parameters<typeof handlePageGatewayEvent>[1];
      handlePageGatewayEvent(state, observerEvent());
      handlePageGatewayEvent(state, observerEvent("r2"));
      expect(state.observerDigest).toBe(projectedDigest);
      expect(publication).not.toHaveBeenCalled();
      if (owner === "session row") {
        handlePageGatewayEvent(state, observerEvent("r1"));
        expect(state.observerDigest?.headline).toBe("Live status r1");
        expect(publication).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "admits only fresh selected-agent global digests (reconnect=%s)",
    (reconnect) => {
      const publication = vi.fn();
      const current = {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 4,
        updatedAt: 4_000,
        headline: "Current work status",
        health: "grinding" as const,
      };
      const state = createObserverState({
        sessionKey: "global",
        assistantAgentId: "work",
        agentsList: { defaultId: "main", scope: "global" },
        chatRunId: "run-work",
        observerDigest: reconnect ? current : null,
        publication,
      });
      emitGatewayEvent(state, "session.observer", {
        sessionKey: "global",
        agentId: "main",
        runId: "run-work",
        revision: reconnect ? 8 : 1,
        updatedAt: reconnect ? 8_000 : 1_000,
        headline: "main status",
        health: reconnect ? "done" : "on-track",
      });
      expect(state.observerDigest).toBe(reconnect ? current : null);
      expect(publication).not.toHaveBeenCalled();
      emitGatewayEvent(state, "session.observer", {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: reconnect ? 3 : 1,
        updatedAt: reconnect ? 9_000 : 1_000,
        headline: "work status",
        health: "on-track",
      });
      expect(state.observerDigest?.headline).toBe(
        reconnect ? "Current work status" : "work status",
      );
      if (reconnect) {
        expect(publication).not.toHaveBeenCalled();
      } else {
        expect(publication).toHaveBeenCalledOnce();
      }
    },
  );

  it("reconciles a selected global alias with its scoped canonical row after reconnect", () => {
    const publication = vi.fn();
    const state = createObserverState({
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "global",
          },
        },
      },
      chatRunId: null,
      observerDigest: {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 1,
        updatedAt: 1_000,
        headline: "Stale status",
        health: "on-track",
      },
      sessionsResultAgentId: "work",
      sessionsResult: {
        sessions: [
          {
            key: "global",
            hasActiveRun: true,
            activeRunIds: ["run-work"],
            observerDigest: {
              agentId: "work",
              runId: "run-work",
              revision: 2,
              updatedAt: 2_000,
              headline: "Projected status",
              health: "grinding",
            },
          },
        ],
      },
      publication,
    });

    expect(selectedChatSessionRow(state)?.key).toBe("global");
    emitGatewayEvent(state, "session.observer", {
      sessionKey: "global",
      agentId: "work",
      runId: "run-work",
      revision: 3,
      updatedAt: 3_000,
      headline: "Reconnected live status",
      health: "on-track",
    });

    expect(state.observerDigest?.headline).toBe("Reconnected live status");
    expect(publication).toHaveBeenCalledOnce();

    const projectedRow = state.sessionsResult?.sessions[0];
    if (projectedRow?.observerDigest) {
      projectedRow.observerDigest.agentId = "main";
    }
    const sanitized = selectedChatSessionRow(state);
    expect(sanitized?.key).toBe("global");
    expect(sanitized?.activeRunIds).toEqual(["run-work"]);
    expect(sanitized?.observerDigest).toBeUndefined();

    state.sessionsResultAgentId = "main";
    expect(selectedChatSessionRow(state)).toBeUndefined();
  });

  it.each([
    {
      name: "prefers an exact direct row over a preceding stray global row",
      rows: [{ key: "global" }, { key: "agent:work:main", displayName: "Exact work session" }],
      expectedKey: "agent:work:main",
    },
    {
      name: "ignores a lone global row outside configured-global scope",
      rows: [{ key: "global" }],
      expectedKey: undefined,
    },
  ])("$name", ({ rows, expectedKey }) => {
    const state = createObserverState({
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      sessionsResultAgentId: "work",
      sessionsResult: { sessions: rows },
    });

    expect(selectedChatSessionRow(state)?.key).toBe(expectedKey);
  });

  it("tracks waiting approval only for the selected session until resolution", () => {
    const state = {
      ...createToolStreamHost({
        sessionKey: "agent:main:current",
        assistantAgentId: "main",
        chatRunId: "client-run-1",
        chatStreamStartedAt: 1,
      }),
      agentsList: { defaultId: "main" },
      waitingApprovalStatuses: new Map(),
      chatStreamRenderFrame: null,
    } as unknown as ChatPageHost;
    const lifecycleEvent = (
      phase: "waiting-approval" | "approval-resolved",
      sessionKey: string,
      approvalId = "approval-1",
    ) =>
      ({
        type: "event" as const,
        event: "agent",
        payload: {
          runId: "engine-run-1",
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          sessionKey,
          agentId: "main",
          data: { phase, approvalId, toolCallId: `tool-${approvalId}` },
        },
      }) satisfies Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(state, lifecycleEvent("waiting-approval", "agent:main:other"));
    expect(state.waitingApprovalStatuses.size).toBe(0);

    handlePageGatewayEvent(state, lifecycleEvent("waiting-approval", state.sessionKey));
    expect(state.waitingApprovalStatuses.get("approval-1")).toEqual({
      runId: "engine-run-1",
    });

    handlePageGatewayEvent(state, lifecycleEvent("approval-resolved", "agent:main:other"));
    expect(state.waitingApprovalStatuses.has("approval-1")).toBe(true);

    handlePageGatewayEvent(
      state,
      lifecycleEvent("waiting-approval", state.sessionKey, "approval-2"),
    );
    handlePageGatewayEvent(state, lifecycleEvent("approval-resolved", state.sessionKey));
    expect([...state.waitingApprovalStatuses.keys()]).toEqual(["approval-2"]);

    handlePageGatewayEvent(
      state,
      lifecycleEvent("approval-resolved", state.sessionKey, "approval-2"),
    );
    expect(state.waitingApprovalStatuses.size).toBe(0);
  });

  it("skips no-op assistant publication while tool changes render on the next frame", () => {
    const requestAnimationFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const publication = vi.fn();
    const state = createStreamEventState({
      publication,
      chatStreamSegments: [],
      chatToolMessages: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      toolStreamSyncTimer: null,
      sessions: {
        reconcileMutation: vi.fn(async () => ({ status: "refreshed" as const })),
      } as never,
    });
    const emitAgent = (seq: number, stream: string, data: Record<string, unknown>) =>
      emitGatewayEvent(state, "agent", {
        runId: "run-1",
        seq,
        stream,
        ts: seq,
        sessionKey: "main",
        data,
      });

    emitAgent(1, "assistant", { text: "Hello", delta: "Hello" });
    expect(publication).not.toHaveBeenCalled();

    emitAgent(2, "tool", { phase: "start", name: "read", toolCallId: "tool-1" });
    emitAgent(3, "tool", { phase: "update", name: "read", toolCallId: "tool-1" });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(publication).not.toHaveBeenCalled();
  });

  it("projects hidden Gateway state without scheduling animation frames", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const requestAnimationFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const publication = vi.fn();
    const state = createStreamEventState({ publication });

    for (const text of ["A", "AB", "ABC"]) {
      emitGatewayEvent(state, "chat", {
        state: "delta",
        runId: "run-1",
        sessionKey: "main",
        deltaText: text.slice(-1),
        message: textMessage(text),
      });
    }

    expect(state.chatStream).toBe("ABC");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(publication).toHaveBeenCalledTimes(3);

    emitGatewayEvent(state, "session.observer", {
      sessionKey: "main",
      runId: "run-1",
      revision: 1,
      updatedAt: 1_000,
      headline: "Waiting for a tool",
      health: "grinding",
    });
    emitGatewayEvent(state, "session.operation", {});

    expect(state.observerDigest?.headline).toBe("Waiting for a tool");
    expect(publication).toHaveBeenCalledTimes(5);
  });

  it("forces one PR-chips refresh per PR link seen in the live stream", () => {
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
    const refreshSessionPullRequests = vi.fn(() => true);
    const state = createStreamEventState({
      refreshSessionPullRequests,
    });
    const delta = (deltaText: string, runId = "run-1") =>
      emitGatewayEvent(state, "chat", { state: "delta", runId, sessionKey: "main", deltaText });

    delta("working on it ");
    expect(refreshSessionPullRequests).not.toHaveBeenCalled();

    // Issue links never carry chips.
    delta("see https://github.com/openclaw/openclaw/issues/42 ");
    expect(refreshSessionPullRequests).not.toHaveBeenCalled();

    delta("opened https://github.com/openclaw/openclaw/pull/113840 for review ");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);
    expect(refreshSessionPullRequests).toHaveBeenCalledWith({ refresh: true, automatic: true });

    // One refresh reloads all of the branch's PRs; further links in the same
    // run must not spend more GitHub quota.
    delta("also https://github.com/openclaw/openclaw/pull/113900 ");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);

    // Streaming may split a URL across chunks; the rolling tail rejoins it.
    delta("continuing https://github.com/openclaw/openclaw/pu", "run-2");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);
    delta("ll/113901 done", "run-2");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(2);

    // A later run announcing the same PR (e.g. its merge) refreshes again.
    delta("merged https://github.com/openclaw/openclaw/pull/113840 at last", "run-3");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "schedules effects for the requested commit and cancels on disconnect=%s",
    async (disconnect) => {
      const { promise: nextCommit, resolve: resolveCommit } = createDeferred<boolean>();
      const awaitDomCommit = vi.fn(() => nextCommit);
      const host = { awaitDomCommit } satisfies Parameters<typeof createChatState<ChatPageHost>>[0];
      const { controller, dispose } = createOwner(host);
      const renderLifecycle = controller.createRenderLifecycle();
      const effect = vi.fn();
      renderLifecycle.afterCommit(effect);
      await Promise.resolve();
      expect(awaitDomCommit).toHaveBeenCalledOnce();
      expect(effect).not.toHaveBeenCalled();
      if (disconnect) {
        dispose();
      }
      resolveCommit(true);
      await nextCommit;
      if (disconnect) {
        expect(effect).not.toHaveBeenCalled();
      } else {
        expect(effect).toHaveBeenCalledOnce();
      }
    },
  );

  it("cancels startup admission when its chat state owner disconnects", async () => {
    vi.useFakeTimers();
    let ready = false;
    const writes: RequestFrame[] = [];
    const pending = new GatewayPendingRequests({
      createRequestId: () => "navigation",
      nowMs: Date.now,
    });
    onTestFinished(() => {
      pending.flush(new Error("test request owner disposed"));
      vi.useRealTimers();
    });
    const wire = {
      send(raw: string) {
        const request = JSON.parse(raw) as RequestFrame;
        if (ready) {
          writes.push(request);
        }
        pending.handleResponse(startupAdmissionResponse(request, ready));
      },
    };
    const { controller, dispose } = createOwner(createRenderer());
    const state = createPageState(
      createChatPageStateContext(),
      controller.createRenderLifecycle(),
      document.createElement("div"),
    );
    state.client = createTestGatewayClient((method, params, options) =>
      pending.request(wire, method, params, options),
    );
    state.connected = true;
    state.sessionKey = "agent:main:startup-navigation";
    controller.attach(state);
    const sending = requestChatSend(state, {
      message: "Wait for this agent",
      runId: "waiting",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(pending.hasPending).toBe(true);
    dispose();
    expect(await sending).toMatchObject({ message: "gateway request aborted for chat.send" });
    ready = true;
    await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
    expect(writes).toHaveLength(0);
    expect(pending.hasPending).toBe(false);
  });

  it("fully tears down realtime Talk when its state owner disconnects", () => {
    const host = createRenderer();
    const { controller, dispose } = createOwner(host);
    const renderLifecycle = controller.createRenderLifecycle();
    const state = createPageState(createChatPageStateContext(), renderLifecycle, {
      dispatchEvent: () => true,
    });
    const stop = vi.fn(() => {
      expect(state.realtimeTalk.snapshot.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalk.update({
      realtimeTalkSession: {
        stop,
      } as unknown as ChatPageHost["realtimeTalk"]["snapshot"]["realtimeTalkSession"],
    });
    state.realtimeTalk.update({ realtimeTalkActive: true });
    state.realtimeTalk.update({ realtimeTalkStatus: "listening" });
    state.realtimeTalk.update({ realtimeTalkDetail: "live" });
    state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(0.8);
    state.realtimeTalk.snapshot.realtimeTalkConversationState.entries = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];
    state.realtimeTalk.update({ realtimeTalkVideoStream: {} as MediaStream });
    state.realtimeTalk.update({
      realtimeTalkCameraDevices: [{ deviceId: "camera", label: "Camera" }],
    });
    state.realtimeTalk.update({ realtimeTalkVideoCapable: true });
    state.realtimeTalk.update({ realtimeTalkVideoPending: true });
    state.realtimeTalk.update({ realtimeTalkCameraError: true });
    controller.attach(state);

    dispose();

    expect(stop).toHaveBeenCalledOnce();
    expect(state.realtimeTalk.snapshot.realtimeTalkActive).toBe(false);
    expect(state.realtimeTalk.snapshot.realtimeTalkStatus).toBe("idle");
    expect(state.realtimeTalk.snapshot.realtimeTalkDetail).toBeNull();
    expect(state.realtimeTalk.snapshot.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalk.snapshot.realtimeTalkConversationState.entries).toEqual([]);
    expect(state.realtimeTalk.snapshot.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalk.snapshot.realtimeTalkCameraDevices).toEqual([]);
    expect(state.realtimeTalk.snapshot.realtimeTalkVideoCapable).toBe(false);
    expect(state.realtimeTalk.snapshot.realtimeTalkVideoPending).toBe(false);
    expect(state.realtimeTalk.snapshot.realtimeTalkCameraError).toBe(false);
  });

  it("aborts attachment reads when a chat pane disconnects", () => {
    const host = createRenderer();
    const { controller, dispose } = createOwner(host);
    const previousSignal = controller.attachmentReads.readSignal;

    controller.attachmentReads.updatePending(previousSignal, 1);
    dispose();

    expect(previousSignal.aborted).toBe(true);
    expect(controller.attachmentReads.pendingReads).toBe(0);
    expect(controller.attachmentReads.readSignal).not.toBe(previousSignal);
    controller.attachmentReads.updatePending(previousSignal, -1);
    expect(controller.attachmentReads.pendingReads).toBe(0);
  });

  it("rejects lifecycle work from detached and replaced state epochs", async () => {
    const awaitDomCommit = vi.fn(async () => true);
    const host = createRenderer({ awaitDomCommit });
    const { controller, dispose } = createOwner(host);
    const first = controller.createRenderLifecycle();
    const replacement = controller.createRenderLifecycle();
    const staleEffect = vi.fn();
    const staleCancel = vi.fn();

    first.afterCommit(staleEffect, staleCancel);

    expect(awaitDomCommit).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledOnce();

    dispose();
    replacement.afterCommit(staleEffect, staleCancel);

    expect(awaitDomCommit).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledTimes(2);

    const renewed = createOwner(host);
    const current = renewed.controller.createRenderLifecycle();
    const currentEffect = vi.fn();
    current.afterCommit(currentEffect);
    await Promise.resolve();

    expect(awaitDomCommit).toHaveBeenCalledOnce();
    expect(currentEffect).toHaveBeenCalledOnce();
  });

  it("cancels post-commit paint frames on disconnect", async () => {
    const { frames, cancelFrame } = captureAnimationFrames();
    const host = createRenderer();
    const { controller, dispose } = createOwner(host);
    const renderLifecycle = controller.createRenderLifecycle();
    const painted = vi.fn();

    scheduleControlUiAfterPaint({ renderLifecycle }, painted);
    await Promise.resolve();

    const firstFrame = frames.get(1);
    expect(firstFrame).toBeDefined();
    frames.delete(1);
    firstFrame?.(0);
    const secondFrame = frames.get(2);
    expect(secondFrame).toBeDefined();

    dispose();
    secondFrame?.(0);

    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(painted).not.toHaveBeenCalled();
  });

  it.each([
    { handled: true, selection: 0 },
    { handled: false, selection: 5 },
  ] as const)(
    "publishes the recalled draft only when history handles the key: $handled",
    ({ handled, selection }) => {
      const { controller, dispose } = createOwner(createRenderer());
      const renderLifecycle = controller.createRenderLifecycle();
      const state = createPageState(createChatPageStateContext(), renderLifecycle, {
        sessionKey: "agent:main:current",
        dispatchEvent: () => true,
      });
      const navigateHistory = vi.fn(() => {
        if (handled) {
          state.chatMessage = "recalled draft";
        }
        return { handled, preventDefault: handled, restoreCaret: handled ? "up" : null } as const;
      });
      state.handleChatInputHistoryKey = navigateHistory;
      const publishedDrafts: string[] = [];
      let unsubscribe = () => {};
      try {
        controller.attach(state);
        unsubscribe = controller.composerDraft.subscribe(() => {
          publishedDrafts.push(controller.composerDraft.read().draft);
        });
        const input = createInputHistoryKey(selection, selection);
        const result = state.handleChatInputHistoryKey!(input);

        expect(result.handled).toBe(handled);
        expect(navigateHistory).toHaveBeenCalledWith(input);
        expect(publishedDrafts).toEqual(handled ? ["recalled draft"] : []);
      } finally {
        unsubscribe();
        dispose();
      }
    },
  );
});

describe("session pull request refresh", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createFinalReplyState(refreshSessionPullRequests: ReturnType<typeof vi.fn>) {
    return {
      ...makeChatHost(),
      chatMessagesBySession: new Map(),
      chatStreamRenderFrame: null,
      pendingSessionMessageReloadSessionKey: null,
      refreshSessionPullRequests,
      sessionKey: "main",
      sessions: { reconcileRunTerminal: vi.fn() },
      settings: {},
    } as unknown as ChatPageHost;
  }

  it.each([
    {
      name: "requests an authoritative refresh after a final assistant PR link",
      text: "Opened `https://github.com/openclaw/openclaw/pull/111532`.",
      refresh: true,
    },
    {
      name: "refreshes for a visible same-session final from another run",
      text: "Opened https://github.com/openclaw/openclaw/pull/111532",
      activeRunId: "active-run",
      runId: "announcement-run",
      refresh: true,
    },
    {
      name: "does not inspect the active stream for another run's final",
      text: "Finished the background task.",
      activeRunId: "active-run",
      runId: "announcement-run",
      stream: "Opened https://github.com/openclaw/openclaw/pull/111532",
      refresh: false,
    },
    {
      name: "does not refresh for an issue link",
      text: "Tracked in https://github.com/openclaw/openclaw/issues/111532.",
      refresh: false,
    },
    {
      name: "does not refresh for another session's PR announcement",
      text: "Opened https://github.com/openclaw/openclaw/pull/111532",
      sessionKey: "agent:main:other",
      refresh: false,
    },
  ])("$name", ({ text, activeRunId, runId, stream, sessionKey, refresh }) => {
    vi.useFakeTimers();
    const refreshSessionPullRequests = vi.fn(() => true);
    const state = createFinalReplyState(refreshSessionPullRequests);
    if (activeRunId) {
      state.chatRunId = activeRunId;
    }
    if (stream) {
      state.chatStream = stream;
    }

    emitGatewayEvent(state, "chat", {
      state: "final",
      ...(runId ? { runId } : {}),
      sessionKey: sessionKey ?? "main",
      message: textMessage(text),
    });

    if (refresh) {
      expect(refreshSessionPullRequests).toHaveBeenCalledWith({ refresh: true, automatic: true });
    } else {
      expect(refreshSessionPullRequests).not.toHaveBeenCalled();
    }
  });
});

describe("loadPageAssistantIdentity", () => {
  it("rejects a stale identity after switching the selected global agent", async () => {
    const staleIdentity = createDeferred<{ name: string; agentId: string }>();
    let holdMainIdentity = true;
    const request = vi.fn((method: string, params?: unknown) => {
      const agentId = asOptionalRecord(params)?.agentId;
      if (method === "chat.metadata" || method === "models.list") {
        return Promise.resolve({ commands: [], models: [] });
      }
      if (method === "models.authStatus") {
        return Promise.resolve({ ts: 1, providers: [] });
      }
      if (agentId === "main" && holdMainIdentity) {
        holdMainIdentity = false;
        return staleIdentity.promise;
      }
      return Promise.resolve({
        name: agentId === "work" ? "Work Agent" : "Main Agent",
        agentId: agentId ?? "main",
      });
    });
    const client = createTestGatewayClient(request);
    const context = createChatPageStateContext();
    Object.assign(context.gateway.snapshot, { client, phase: "connected" });
    vi.spyOn(context.sessions, "refresh").mockResolvedValue(undefined);
    const state = createPageState(
      context,
      { afterCommit: () => () => {} },
      { dispatchEvent: () => true },
    );
    Object.assign(state, {
      client,
      connected: true,
      sessionKey: "global",
      assistantAgentId: "main",
      agentsList: {
        agents: [{ id: "main" }, { id: "work" }],
        defaultId: "main",
        mainKey: "main",
        scope: "global",
      },
    });
    const pendingMainIdentity = state.loadAssistantIdentity();
    applySelectedChatAgent(state, "work");
    staleIdentity.resolve({ name: "Stale Main Agent", agentId: "main" });
    await pendingMainIdentity;
    await vi.waitFor(() => expect(state.assistantName).toBe("Work Agent"));
    expect(state.assistantAgentId).toBe("work");
  });
});

describe("refreshChatMetadata", () => {
  function createMetadataState(
    request: ReturnType<typeof vi.fn>,
    overrides: Partial<Omit<ChatPageHost, "hello">> & {
      hello?: { features: { methods: string[] } };
    } = {},
  ): ChatPageHost {
    return {
      ...makeChatHost(),
      agentsList: null,
      assistantAgentId: "main",
      client: { request },
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
      ...overrides,
    } as unknown as ChatPageHost;
  }

  it("ends a retired automatic catalog's loading before unrelated commands settle", async () => {
    const catalog = createDeferred<{ models: [] }>();
    const commands = createDeferred<{ commands: [] }>();
    const request = vi.fn((method: string) =>
      method === "models.list" ? catalog.promise : commands.promise,
    );
    const state = createMetadataState(request);
    const automatic = refreshChatMetadata(state);
    try {
      expect(state.chatModelsLoading).toBe(true);
      invalidateModelCatalogCache(state.client!, {
        agentId: "work",
        sessionKey: state.sessionKey,
      });
      catalog.resolve({ models: [] });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(state.chatModelsLoading).toBe(false);
      expect(requestCalls(request, "models.list")).toHaveLength(1);
    } finally {
      catalog.resolve({ models: [] });
      commands.resolve({ commands: [] });
      await automatic;
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  });

  it("shares a failed automatic catalog attempt until the picker recovers it", async () => {
    const models = [{ id: "fresh", name: "Fresh", provider: "test" }];
    let failing = true;
    const request = vi.fn(async (method: string) => {
      if (failing) {
        throw new Error("Shared automatic failure");
      }
      return method === "models.list" ? { models } : { commands: [] };
    });
    const first = createMetadataState(request);
    const follower = createMetadataState(request, { client: first.client });
    const counts = () =>
      ["chat.metadata", "models.list"].map(
        (method) => request.mock.calls.filter(([called]) => called === method).length,
      );
    try {
      await Promise.all([refreshChatMetadata(first), refreshChatMetadata(follower)]);
      await refreshChatMetadata(follower);
      expect(counts()).toEqual([1, 1]);
      expect(follower.chatModelCatalogError).toContain("Shared automatic failure");
      failing = false;
      await refreshChatModelCatalogOnDemand(first);
      await refreshChatMetadata(follower);
      expect(counts()).toEqual([2, 2]);
      expect(follower.chatModelCatalog).toEqual(models);
      expect(follower.chatModelCatalogError).toBeNull();
    } finally {
      for (const state of [first, follower]) {
        retireChatMetadataRequests(state);
        state.sessions.dispose();
      }
    }
  });

  it("keeps a fresh picker snapshot usable while automatic admission waits for commands", async () => {
    const models = [{ id: "fresh", name: "Fresh", provider: "test" }];
    const catalog = createDeferred<{ models: typeof models }>();
    const pendingCommands = createDeferred<{ commands: [] }>();
    const request = vi.fn((method: string) =>
      method === "models.list"
        ? catalog.promise
        : method === "chat.metadata"
          ? pendingCommands.promise
          : Promise.resolve({}),
    );
    const state = createMetadataState(request);
    const picker = refreshChatModelCatalogOnDemand(state);
    const commands = revalidateChatMetadata(state.client!, {
      agentId: "work",
      sessionKey: state.sessionKey,
    });
    const automatic = refreshChatMetadata(state);
    try {
      catalog.resolve({ models });
      await picker;
      expect(state.chatModelCatalog).toEqual(models);
      expect(state.chatModelsLoading).toBe(false);
      expect(requestCalls(request, "models.list")).toHaveLength(1);
    } finally {
      catalog.resolve({ models });
      pendingCommands.resolve({ commands: [] });
      await Promise.all([commands, automatic, picker]);
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  });

  it.each(
    ["settled", "catalog-first", "selection-first"].flatMap((order) => [
      { order, picker: false },
      { order, picker: true },
    ]),
  )(
    "keeps foreground session selection through catalog refresh ($order, picker=$picker)",
    async ({ order, picker }) => {
      vi.useFakeTimers();
      const catalog = createDeferred<{ models: [] }>();
      const mainList = createDeferred<ReturnType<typeof sessionsResult>>();
      let revision = 1;
      let catalogInvalidated = false;
      let holdMain = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "models.list") {
          return catalogInvalidated ? catalog.promise : { models: [] };
        }
        if (method !== "sessions.list") {
          return { commands: [] };
        }
        const args = asOptionalRecord(params);
        if (args?.agentId === "main" && holdMain) {
          holdMain = false;
          return mainList.promise;
        }
        const row: GatewaySessionRow = {
          key: `agent:${String(args?.agentId)}:kept`,
          kind: "direct",
          label: `Kept ${revision}`,
          updatedAt: revision,
          ...(args?.includeLastMessage ? { lastMessagePreview: "Saved preview" } : {}),
        };
        return sessionsResult(
          args?.search === "keep"
            ? [row]
            : [row, { key: "agent:work:other", kind: "direct", updatedAt: revision }],
          revision,
        );
      });
      const client = createTestGatewayClient(request);
      const { gateway } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const state = createMetadataState(request, {
        client,
        sessions,
        sessionKey: "agent:main:retained",
      });
      const workQuery = { agentId: "work", search: "keep", includeLastMessage: true };
      const oldMain = sessionsResult(
        [{ key: "agent:main:kept", kind: "direct", label: "Main", updatedAt: 1 }],
        1,
      );
      let oldRefresh: Promise<void> | undefined;
      let selection: Promise<void> | undefined;
      let refresh: Promise<void> | undefined;
      try {
        await refreshChatMetadata(state);
        await sessions.refresh({ agentId: "main" });
        if (order === "settled") {
          await sessions.refresh(workQuery);
        } else {
          holdMain = true;
          oldRefresh = sessions.refresh({ agentId: "main", force: true });
          selection = sessions.refresh(workQuery);
        }
        catalogInvalidated = true;
        invalidateChatMetadataStore(client);
        refresh = picker ? refreshChatModelCatalogOnDemand(state) : refreshChatMetadata(state);
        if (order === "selection-first") {
          mainList.resolve(oldMain);
          await Promise.all([oldRefresh, selection]);
          expect(sessions.state.agentId).toBe("work");
        }
        revision = 2;
        catalog.resolve({ models: [] });
        await vi.advanceTimersByTimeAsync(1_000);
        mainList.resolve(oldMain);
        await Promise.all([oldRefresh, selection, refresh]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sessions.state.agentId).toBe("work");
        expect(sessions.state.result?.sessions).toEqual([
          {
            key: "agent:work:kept",
            kind: "direct",
            label: `Kept ${order === "catalog-first" ? 2 : 1}`,
            lastMessagePreview: "Saved preview",
            updatedAt: order === "catalog-first" ? 2 : 1,
          },
        ]);
      } finally {
        retireChatMetadataRequests(state);
        sessions.dispose();
        mainList.resolve(oldMain);
        catalog.resolve({ models: [] });
        await Promise.allSettled([oldRefresh, selection, refresh]);
        vi.useRealTimers();
      }
    },
  );

  it("keeps the scoped bootstrap when a picker catalog completes before history", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:work:literal-session";
    const bootstrap = createConnectionBootstrapCoordinator();
    bootstrap.setForegroundRoute(sessionKey);
    const result = sessionsResult([{ key: sessionKey, kind: "direct", updatedAt: 1 }], 1);
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      return method === "sessions.list" ? result : { models: [] };
    });
    const client = createTestGatewayClient(request);
    const { gateway, publish } = createGatewayHarness(client);
    const sessions = createSessionCapability(
      gateway,
      { state: { selectedId: "work" }, subscribe: () => () => {} },
      { connectionBootstrap: bootstrap },
    );
    const state = createMetadataState(request, { client, sessions, sessionKey });
    try {
      bootstrap.synchronize({ client, connected: true });
      publish(true);
      await refreshChatModelCatalogOnDemand(state);
      await vi.advanceTimersByTimeAsync(250);
      expect(requestCalls(request, "sessions.list")).toEqual([]);

      bootstrap.setForegroundPane({}, { sessionKey, client, ready: true });
      await vi.advanceTimersByTimeAsync(250);
      expect(requestCalls(request, "sessions.list")).toEqual([
        ["sessions.list", expect.objectContaining({ agentId: "work", includeLastMessage: true })],
      ]);
      expect(sessions.state.agentId).toBe("work");
      expect(sessions.state.result?.sessions).toEqual(result.sessions);
    } finally {
      retireChatMetadataRequests(state);
      sessions.dispose();
      bootstrap.reset();
      vi.useRealTimers();
    }
  });

  it.each([
    [false, false, false, false, false],
    [true, false, false, false, false],
    [false, true, false, false, false],
    [false, true, true, false, false],
    [false, true, true, true, false],
    [false, true, true, false, true],
  ])(
    "converges catalog invalidation with pending picker=%s, scoped follow-up=%s, metadata=%s, hidden=%s and empty=%s",
    async (pickerPending, scopedAfterGlobal, metadataPending, hidden, empty) => {
      const prepared = { id: "model", name: "Model", provider: "test", contextWindow: 8_192 };
      const discovered = { ...prepared, contextWindow: 262_144 };
      const acceptedModels = empty ? [] : [discovered];
      const retiredCatalog = createDeferred<{ models: (typeof prepared)[] }>();
      const currentCatalog = createDeferred<{ models: (typeof prepared)[] }>();
      const metadata = createDeferred<{ commands: [] }>();
      let invalidated = false;
      let catalogReads = 0;
      const request = vi.fn((method: string) =>
        method === "chat.metadata"
          ? metadataPending && invalidated
            ? metadata.promise
            : Promise.resolve({ commands: [] })
          : method === "sessions.describe"
            ? Promise.resolve({})
            : invalidated
              ? ++catalogReads === 1
                ? retiredCatalog.promise
                : currentCatalog.promise
              : Promise.resolve({ models: [prepared] }),
      );
      const state = createMetadataState(request);
      let follower: ChatPageHost | undefined;
      const invalidateSessions = vi
        .spyOn(state.sessions, "invalidate")
        .mockImplementation(() => {});
      try {
        await refreshChatMetadata(state);
        expect(invalidateSessions).not.toHaveBeenCalled();
        const picker = pickerPending ? refreshChatModelCatalogOnDemand(state) : undefined;
        invalidated = true;
        invalidateChatMetadataStore(state.client!);
        if (scopedAfterGlobal) {
          invalidateChatMetadataStore(state.client!, {
            agentId: "work",
            sessionKey: state.sessionKey,
          });
        }
        expect(invalidateSessions).not.toHaveBeenCalled();
        state.chatMetadataIsPresented = () => !hidden;
        retiredCatalog.resolve({ models: [discovered] });
        if (metadataPending) {
          const scope = { agentId: "work", sessionKey: state.sessionKey };
          publishModelCatalogResult(beginModelCatalogRead(state.client!, scope), scope, {
            models: acceptedModels,
          });
          applyChatModelCatalogSnapshot(state);
          expect(state.chatModelCatalog).toEqual(acceptedModels);
          if (empty) {
            follower = createMetadataState(request, { client: state.client });
            void refreshChatMetadata(follower);
            expect(follower.chatModelsLoading).toBe(false);
            expect(follower.chatModelCatalog).toEqual([]);
          }
          if (hidden) {
            expect(requestCalls(request, "sessions.describe")).toEqual([]);
            state.chatMetadataIsPresented = () => true;
            void refreshChatMetadata(state);
          }
        } else {
          currentCatalog.resolve({ models: [discovered] });
        }
        await vi.waitFor(() => expect(requestCalls(request, "sessions.describe")).toHaveLength(1));
        expect(invalidateSessions).not.toHaveBeenCalled();
        await picker;

        expect(state.chatModelCatalog).toEqual(acceptedModels);
        metadata.resolve({ commands: [] });
        await refreshChatMetadata(state);
      } finally {
        retiredCatalog.resolve({ models: [discovered] });
        currentCatalog.resolve({ models: [discovered] });
        metadata.resolve({ commands: [] });
        retireChatMetadataRequests(state);
        if (follower) {
          retireChatMetadataRequests(follower);
          follower.sessions.dispose();
        }
      }
    },
  );

  it.each(["session", "agent", "connection"])(
    "does not refresh session facts after an invalidated catalog loses its %s owner",
    async (transition) => {
      const pending = createDeferred<{ models: [] }>();
      const replacement = createDeferred<{ models: [] }>();
      let catalogReads = 0;
      const request = vi.fn((method: string) =>
        method === "chat.metadata"
          ? Promise.resolve({ commands: [] })
          : method === "sessions.describe"
            ? Promise.resolve({})
            : ++catalogReads === 1
              ? Promise.resolve({ models: [] })
              : catalogReads === 2
                ? pending.promise
                : replacement.promise,
      );
      const state = createMetadataState(request, {
        sessionKey: "global",
        assistantAgentId: "work",
      });
      try {
        await refreshChatMetadata(state);
        request.mockClear();
        invalidateChatMetadataStore(state.client!);
        const refresh = refreshChatMetadata(state);
        if (transition === "session") {
          state.sessionKey = "agent:work:other";
        } else if (transition === "agent") {
          state.assistantAgentId = "main";
        } else {
          state.connectionEpoch += 1;
        }
        pending.resolve({ models: [] });
        await refresh;
        expect(requestCalls(request, "sessions.describe")).toEqual([]);
      } finally {
        retireChatMetadataRequests(state);
        replacement.resolve({ models: [] });
      }
    },
  );

  it.each([
    {
      label: "warm",
      existingModels: [{ id: "cached-model", name: "Cached Model", provider: "openai" }],
    },
    { label: "cold", existingModels: [] },
  ])(
    "reads the $label session catalog without provider acquisition",
    async ({ existingModels }) => {
      const discovery = createDeferred<{
        models: Array<{ id: string; name: string; provider: string; reasoning: boolean }>;
      }>();
      const request = vi.fn((method: string, params?: unknown) => {
        if (method === "sessions.describe") {
          return Promise.resolve({});
        }
        expect(method).toBe("models.list");
        expect(params).toEqual({
          view: "configured",
          agentId: "work",
          sessionKey: "agent:work:main",
        });
        return discovery.promise;
      });
      const state = createMetadataState(request, {
        chatModelCatalog: existingModels,
      });
      const invalidateSessions = vi
        .spyOn(state.sessions, "invalidate")
        .mockImplementation(() => {});

      const refresh = refreshChatModelCatalogOnDemand(state);
      expect(state.chatModelCatalog).toEqual(existingModels);
      expect(state.chatModelsLoading).toBe(existingModels.length === 0);
      discovery.resolve({
        models: [{ id: "reasoner", name: "Reasoner", provider: "dynamic-router", reasoning: true }],
      });
      await refresh;

      expect(state.chatModelCatalog).toEqual([
        {
          id: "reasoner",
          name: "Reasoner",
          provider: "dynamic-router",
          reasoning: true,
        },
      ]);
      expect(invalidateSessions).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("sessions.describe", {
        key: "agent:work:main",
        agentId: "work",
      });
      expect(state.chatModelCatalogError).toBeNull();
    },
  );

  it.each(["session", "agent", "retired pane"])(
    "rejects late metadata after changing its %s owner",
    async (transition) => {
      const metadata = createDeferred<{
        commands: never[];
        models: ChatPageHost["chatModelCatalog"];
      }>();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (transition === "session" && method === "models.list") {
          expect(params).toEqual({
            agentId: "work",
            sessionKey: "agent:work:main",
            view: "configured",
          });
        }
        return await metadata.promise;
      });
      const existingCatalog =
        transition === "session"
          ? []
          : [{ id: "work-model", name: "Work Model", provider: "openai", available: true }];
      const state = createMetadataState(request, { chatModelCatalog: existingCatalog });
      const refresh = refreshChatMetadata(state);
      if (transition === "retired pane") {
        retireChatMetadataRequests(state);
      } else {
        state.sessionKey = transition === "session" ? "agent:work:another" : "agent:other:main";
      }
      metadata.resolve({
        commands: [],
        models: [{ id: "late-model", name: "Late Model", provider: "openai", available: true }],
      });
      await refresh;
      if (transition === "agent") {
        expect(state.chatModelCatalog).toBe(existingCatalog);
      } else {
        expect(state.chatModelCatalog).toEqual([]);
      }
      if (transition !== "retired pane") {
        expect(requestCalls(request, "models.list")).toHaveLength(1);
      }
    },
  );

  it("keeps loading owned by the newest agent metadata request", async () => {
    const { promise: workMetadata, resolve: resolveWork } = createDeferred<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>();
    const { promise: otherMetadata, resolve: resolveOther } = createDeferred<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>();
    const request = vi.fn(
      async (_method: string, params?: { agentId?: string }) =>
        await (params?.agentId === "work" ? workMetadata : otherMetadata),
    );
    const state = createMetadataState(request);

    const workRefresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    const otherRefresh = refreshChatMetadata(state);
    resolveWork({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai" }],
    });
    await workRefresh;

    expect(state.chatModelsLoading).toBe(true);
    resolveOther({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await otherRefresh;

    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([
      { id: "other-model", name: "Other Model", provider: "openai" },
    ]);
  });

  it("keeps model reads independent of command metadata failures", async () => {
    const model = { id: "published", name: "Published", provider: "example", available: true };
    const request = vi.fn(async (method: string) => {
      if (method === "chat.metadata") {
        throw new Error("commands unavailable");
      }
      return { models: [model], accountSelection: { kind: "automatic", label: "Automatic" } };
    });
    const state = createMetadataState(request);
    await refreshChatMetadata(state);
    expect(state.chatModelCatalog).toEqual([model]);
    expect(state.chatAccountSelection).toEqual({ kind: "automatic", label: "Automatic" });
    expect(state.chatModelCatalogError).toBeNull();
  });

  it("retains rows after catalog failure and clears failure on a successful empty publication", async () => {
    const model = { id: "retained", name: "Retained", provider: "example" };
    const catalog = vi
      .fn()
      .mockResolvedValueOnce({ models: [model], refreshFailed: true })
      .mockRejectedValueOnce(new Error("catalog transport failed"))
      .mockResolvedValueOnce({ models: [] });
    const request = vi.fn((method: string) =>
      method === "models.list" ? catalog() : Promise.resolve({}),
    );
    const state = createMetadataState(request);
    await refreshChatModelCatalogOnDemand(state);
    expect(state.chatModelCatalog).toEqual([model]);
    expect(state.chatModelCatalogError).toBeNull();
    expect(state.chatModelCatalogRefreshFailed).toBe(true);
    await refreshChatModelCatalogOnDemand(state);
    expect(state.chatModelCatalog).toEqual([model]);
    expect(state.chatModelCatalogError).toBe("catalog transport failed");
    await refreshChatModelCatalogOnDemand(state);
    expect(state.chatModelCatalog).toEqual([]);
    expect(state.chatModelCatalogError).toBeNull();
    expect(state.chatModelCatalogRefreshFailed).toBeUndefined();
  });

  it("keeps fallback slash commands when chat metadata omits commands", async () => {
    replaceSlashCommands(buildFallbackSlashCommands());
    const request = vi.fn(async (method: string) => {
      if (method === "chat.metadata") {
        return {
          models: [{ id: "metadata-model", name: "Metadata Model", provider: "openai" }],
        };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {
        commands: [
          {
            name: "remote-command",
            textAliases: ["/remote-command"],
            description: "Loaded through commands.list.",
            source: "plugin",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      };
    });
    const state = createMetadataState(request);

    await refreshChatMetadata(state);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["models.list", "chat.metadata"]);
    expect(SLASH_COMMANDS.some((command) => command.name === "help")).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === "remote-command")).toBe(false);
  });
});

describe("refreshChatModelAuthStatus", () => {
  it.each([
    undefined,
    {
      code: "PREPARED_MODEL_AUTH_UNAVAILABLE" as const,
      message: "Model authentication status is unavailable. Refresh Models after setup finishes.",
    },
  ])(
    "scopes auth status to the fixed session agent and records unavailable health: %j",
    async (unavailable) => {
      const result = { ts: 1, providers: [], ...(unavailable ? { unavailable } : {}) };
      const request = vi.fn(async () => result);
      const state = {
        client: { request },
        connected: true,
        connectionEpoch: 1,
        sessionKey: "agent:work:dashboard:current",
        assistantAgentId: "main",
        modelAuthStatusRequestVersion: 0,
        modelAuthStatusResult: null,
      } as unknown as ChatPageHost;

      await refreshChatModelAuthStatus(state);
      applySelectedChatAgent(state, "research");

      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "work" });
      expect(request).toHaveBeenCalledOnce();
      expect(state.assistantAgentId).toBe("main");
      expect(state.modelAuthStatusResult).toBe(result);
      expect(state.connected).toBe(true);
    },
  );

  it.each(["success", "failure"] as const)(
    "rebinds selected-global auth and rejects the superseded Main %s",
    async (outcome) => {
      const mainResponse = createDeferred<{ ts: number; providers: never[] }>();
      const workResponse = createDeferred<{ ts: number; providers: never[] }>();
      const request = vi.fn((method: string, params?: { agentId?: string }) => {
        if (method === "chat.metadata" || method === "models.list") {
          return Promise.resolve({ commands: [], models: [] });
        }
        return (params?.agentId === "work" ? workResponse : mainResponse).promise;
      });
      const staleMainStatus = { ts: 1, providers: [] };
      const workStatus = { ts: 2, providers: [] };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      const state = {
        client: { request },
        connected: true,
        connectionEpoch: 1,
        sessionKey: "global",
        assistantAgentId: "main",
        assistantIdentityRequestVersion: 0,
        modelAuthStatusRequestVersion: 0,
        modelAuthStatusResult: staleMainStatus,
        loadAssistantIdentity: vi.fn(async () => undefined),
        chatModelSwitchPromises: {},
        chatModelCatalog: [],
        chatModelCatalogError: null,
        chatModelsLoading: false,
        sessions: {
          state: { modelOverrides: {} },
          retireModelOverride: vi.fn(),
          refresh: refreshSessions,
        },
      } as unknown as ChatPageHost;

      const mainRefresh = refreshChatModelAuthStatus(state);
      applySelectedChatAgent(state, "work");

      expect(state.assistantAgentId).toBe("work");
      expect(state.modelAuthStatusResult).toBeNull();
      expect(requestCalls(request, "models.authStatus")).toEqual([
        ["models.authStatus", { agentId: "main" }],
        ["models.authStatus", { agentId: "work" }],
      ]);
      expect(refreshSessions).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "work", force: true }),
      );

      workResponse.resolve(workStatus);
      await vi.waitFor(() => expect(state.modelAuthStatusResult).toBe(workStatus));

      if (outcome === "success") {
        mainResponse.resolve({ ts: 3, providers: [] });
      } else {
        mainResponse.reject(new Error("stale Main auth status"));
      }
      await mainRefresh;

      expect(state.modelAuthStatusResult).toBe(workStatus);
    },
  );

  it.each(["success", "failure"] as const)(
    "ignores a stale auth status %s after reconnecting the same client",
    async (outcome) => {
      const {
        promise: response,
        resolve: resolveStatus,
        reject: rejectStatus,
      } = createDeferred<{ ts: number; providers: never[] }>();
      const request = vi.fn(() => response);
      const currentStatus = { ts: 2, providers: [] };
      const state = {
        client: { request },
        connected: true,
        connectionEpoch: 1,
        modelAuthStatusRequestVersion: 0,
        modelAuthStatusResult: currentStatus,
      } as unknown as ChatPageHost;

      const refresh = refreshChatModelAuthStatus(state);
      state.connected = false;
      state.connectionEpoch += 1;
      state.connected = true;
      state.connectionEpoch += 1;

      if (outcome === "success") {
        resolveStatus({ ts: 1, providers: [] });
      } else {
        rejectStatus(new Error("stale connection auth status"));
      }
      await refresh;

      expect(state.modelAuthStatusResult).toBe(currentStatus);
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
