// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import {
  adoptStartedChatRun,
  reconcileChatRunAfterSessionStatePublication,
} from "./run-lifecycle.ts";

type AbortDiagnosticState = ChatState & {
  chatRunStatus?: { phase: string; runId: string | null; sessionKey: string } | null;
  lastLocalTerminalReconcile?: { sessionStatus: string } | null;
  sessionsResult?: {
    ts: number;
    path: string;
    count: number;
    defaults: Record<string, unknown>;
    sessions: Array<Record<string, unknown>>;
  };
};

function createAbortDiagnosticState(runId = "run-validation-abort"): AbortDiagnosticState {
  return {
    chatAttachments: [],
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunError: null,
    chatRunId: runId,
    chatSending: false,
    chatStream: "Partial assistant reply",
    chatStreamStartedAt: 100,
    chatRunStartup: null,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: {},
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          activeRunIds: [runId],
          status: "running",
          startedAt: 100,
        },
      ],
    },
  };
}

describe("aborted chat diagnostics", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { name: "plain cancellation", errorMessage: undefined, expectedError: null },
    {
      name: "validation self-abort",
      errorMessage: "edit tool validation failed: edits: must be an array",
      expectedError: "Error: edit tool validation failed: edits: must be an array",
    },
  ])("keeps first-terminal $name killed and interrupted", ({ errorMessage, expectedError }) => {
    const state = createAbortDiagnosticState();
    const payload: ChatEventPayload = {
      runId: "run-validation-abort",
      sessionKey: "main",
      state: "aborted",
      ...(errorMessage ? { errorMessage } : {}),
    };

    expect(handleChatGatewayEvent(state, payload)).toBe("aborted");

    expect(state.chatRunError?.summary ?? null).toBe(expectedError);
    expect(state.chatRunStatus).toMatchObject({
      phase: "interrupted",
      runId: "run-validation-abort",
      sessionKey: "main",
    });
    expect(state.lastLocalTerminalReconcile?.sessionStatus).toBe("killed");
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      activeRunIds: [],
      hasActiveRun: false,
      status: "killed",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("surfaces one late aborted diagnostic and ignores its replay", () => {
    const state = createAbortDiagnosticState();
    const aborted = {
      runId: "run-validation-abort",
      sessionKey: "main",
      state: "aborted" as const,
    };
    const diagnostic = {
      ...aborted,
      errorMessage: "edit tool validation failed: edits: must be an array",
    };

    expect(handleChatGatewayEvent(state, aborted)).toBe("aborted");
    expect(state.chatRunError).toBeNull();
    expect(handleChatGatewayEvent(state, diagnostic)).toBe("aborted");
    const displayedDiagnostic = state.chatRunError;
    expect(handleChatGatewayEvent(state, diagnostic)).toBe("aborted");

    expect(state.chatRunError).toBe(displayedDiagnostic);
    expect(state.chatRunError).toEqual({
      summary: "Error: edit tool validation failed: edits: must be an array",
      runId: "run-validation-abort",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("retains a late error through an identity-incomplete active session publication", () => {
    const state = createAbortDiagnosticState("run-list");
    adoptStartedChatRun(state, "run-list", 100);
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: "run-list",
      state: "aborted",
      seq: 30,
    });
    if (!state.sessionsResult) {
      throw new Error("Expected the session inventory");
    }
    state.sessionsResult.sessions = [
      {
        key: "main",
        kind: "direct",
        updatedAt: 200,
        hasActiveRun: true,
        status: "running",
        lastRunId: "run-list",
      },
    ];
    reconcileChatRunAfterSessionStatePublication(state);
    expect(state.lastLocalTerminalReconcile).toBeNull();
    const diagnostic = {
      sessionKey: "main",
      runId: "run-list",
      state: "error" as const,
      seq: 1,
      errorMessage: "Automations listed.\nCount: 2\nRestricted automation inventory.",
    };
    handleChatGatewayEvent(state, diagnostic);
    expect(state.chatRunError).toEqual({
      runId: "run-list",
      summary: "Error: Automations listed.\nCount: 2\nRestricted automation inventory.",
    });
    state.chatRunError = null;
    handleChatGatewayEvent(state, diagnostic);
    expect(state.chatRunError).toBeNull();
  });

  it.each([
    { name: "unknown active identities", activeRunIds: undefined, displays: true },
    {
      name: "same run with concurrent activity",
      activeRunIds: ["run-list", "run-other"],
      displays: true,
    },
    { name: "proven replacement run", activeRunIds: ["run-new"], displays: false },
  ])("handles $name after the active-row tombstone is gone", ({ activeRunIds, displays }) => {
    const state = createAbortDiagnosticState("run-list");
    adoptStartedChatRun(state, "run-list", 100);
    handleChatGatewayEvent(state, { sessionKey: "main", runId: "run-list", state: "aborted" });
    if (!state.sessionsResult) {
      throw new Error("Expected the session inventory");
    }
    state.sessionsResult.sessions = [
      { key: "main", kind: "direct", updatedAt: 200, hasActiveRun: true, status: "running" },
    ];
    reconcileChatRunAfterSessionStatePublication(state);
    expect(state.lastLocalTerminalReconcile).toBeNull();
    state.sessionsResult.sessions = [
      {
        key: "main",
        kind: "direct",
        updatedAt: 300,
        hasActiveRun: true,
        status: "running",
        activeRunIds,
      },
    ];
    reconcileChatRunAfterSessionStatePublication(state);
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: "run-list",
      state: "error",
      errorMessage: "Late diagnostic",
    });
    expect(state.chatRunError).toEqual(
      displays ? { runId: "run-list", summary: "Error: Late diagnostic" } : null,
    );
  });

  it.each(["reset", "branch", "durable session"] as const)(
    "rejects the old run's error after a %s replacement",
    (replacement) => {
      const state = createAbortDiagnosticState("run-before-replacement");
      state.currentSessionId = "session-before";
      state.chatDisplayedLeafEntryId = "leaf-before";
      adoptStartedChatRun(state, "run-before-replacement", 100);
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-before-replacement",
        state: "aborted",
      });
      if (replacement === "reset") {
        resetChatHistoryProjection(state);
      } else {
        if (replacement === "branch") {
          state.chatDisplayedLeafEntryId = "leaf-after";
        } else {
          state.currentSessionId = "session-after";
        }
        reduceChatSessionProjection(state, { type: "snapshotLoaded", messages: [] });
      }
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-before-replacement",
        state: "error",
        errorMessage: "Obsolete branch diagnostic",
      });
      expect(state.chatRunError).toBeNull();
      expect(state.chatMessages).toEqual([]);
      expect(state.chatRunId).toBeNull();
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "unseen-current-run",
        state: "error",
        errorMessage: "Current background diagnostic",
      });
      expect(state.chatRunError).toEqual({
        runId: "unseen-current-run",
        summary: "Error: Current background diagnostic",
      });
    },
  );

  it("retains known old-run provenance across two resets", () => {
    const state = createAbortDiagnosticState("run-first");
    for (const runId of ["run-first", "run-second"]) {
      adoptStartedChatRun(state, runId, 100);
      handleChatGatewayEvent(state, { sessionKey: "main", runId, state: "aborted" });
      resetChatHistoryProjection(state);
    }
    for (const runId of ["run-first", "run-second"]) {
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId,
        state: "error",
        errorMessage: "Old reset diagnostic",
      });
    }
    expect(state.chatRunError).toBeNull();
    expect(state.chatMessages).toEqual([]);
  });

  it("does not publish a late aborted diagnostic over a newer active run", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatRunId = "run-new";
    state.chatStream = "New run output";

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBe("run-new");
    expect(state.chatStream).toBe("New run output");
  });

  it("does not restore an old diagnostic while a newer send awaits its ACK", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatQueue = [
      {
        id: "pending-new-send",
        text: "New request",
        createdAt: 200,
        sendRunId: "run-new",
        sendState: "sending",
      },
    ];

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-old");
  });

  it("does not publish an old aborted diagnostic after a newer run completes", () => {
    const state = createAbortDiagnosticState("run-old");
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
      }),
    ).toBe("aborted");
    state.chatRunId = "run-new";
    state.chatStream = "New final answer";
    expect(
      handleChatGatewayEvent(state, {
        runId: "run-new",
        sessionKey: "main",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "New final answer" }],
        },
      }),
    ).toBe("final");

    expect(
      handleChatGatewayEvent(state, {
        runId: "run-old",
        sessionKey: "main",
        state: "aborted",
        errorMessage: "edit tool validation failed: invalid arguments",
      }),
    ).toBe("aborted");

    expect(state.chatRunError).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-new");
    expect(state.chatRunId).toBeNull();
    expect(state.chatMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "New final answer" }],
    });
  });
});
