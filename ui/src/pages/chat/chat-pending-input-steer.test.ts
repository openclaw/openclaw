/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSteerResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatHistoryLoadState, setChatError } from "./chat-history-state.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { dismissChatError } from "./chat-pane-state.ts";
import {
  input,
  makeChatPageHost,
  sessionId,
  sessionKey,
} from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";
import { handleChatInputHistoryKey } from "./input-history.ts";

const queued = { ...input, state: "queued" as const, queued: true as const };
const pendingInputs = { items: [queued], total: 1, queuedCount: 1 };
const rowId = "pending-input:" + input.id;

function createHost(steer: () => unknown = () => ({ status: "accepted", runId: input.runId })) {
  const host = makeChatPageHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.steer": steer,
      "chat.history": { sessionId, messages: [], pendingInputs },
    },
  });
  applyChatPendingInputs(host, pendingInputs);
  return host;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gateway-queued input steering", () => {
  it.each(["queued", "rejected"] as const)(
    "preserves an identical diagnostic republished during a %s control request",
    async (outcome) => {
      const response = createDeferred<ChatSteerResult>();
      const host = createHost(() => response.promise);
      setChatError(host, "Another action failed");
      const steering = host.steerQueuedChatMessage(rowId);
      setChatError(host, "Another action failed");
      if (outcome === "queued") {
        response.resolve({ status: "queued", reason: "Old refusal" });
      } else {
        response.reject(new Error("Old refusal"));
      }
      await steering;
      expect(host.chatError).toBe("Another action failed");
      expect(host.lastError).toBe(host.chatError);
    },
  );

  it.each(["queued", "rejected"] as const)(
    "does not resurrect a %s refusal after the user dismisses a newer error",
    async (outcome) => {
      const response = createDeferred<ChatSteerResult>();
      const host = createHost(() => response.promise);
      const steering = host.steerQueuedChatMessage(rowId);
      setChatError(host, "Another action failed");
      dismissChatError(host);
      if (outcome === "queued") {
        response.resolve({ status: "queued", reason: "Old refusal" });
      } else {
        response.reject(new Error("Old refusal"));
      }
      await steering;
      expect(host.chatError).toBeNull();
      expect(host.lastError).toBeNull();
    },
  );

  it("does not clear another action's identical diagnostic on explicit retry", async () => {
    const retryResponse = createDeferred<ChatSteerResult>();
    let attempts = 0;
    const host = createHost(() =>
      ++attempts === 1 ? { status: "queued", reason: "Cannot steer yet" } : retryResponse.promise,
    );
    await host.steerQueuedChatMessage(rowId);
    setChatError(host, "Cannot steer yet");
    const retry = host.steerQueuedChatMessage(rowId);
    try {
      expect(host.chatError).toBe("Cannot steer yet");
      expect(host.lastError).toBe(host.chatError);
    } finally {
      retryResponse.resolve({ status: "accepted" });
      await retry;
    }
    expect(host.chatError).toBe("Cannot steer yet");
  });

  it("releases control busy before stalled history and retries only the same admitted identity", async () => {
    const history = createDeferred<unknown>();
    const historyRequested = createDeferred();
    const retryResponse = createDeferred<ChatSteerResult>();
    let attempts = 0;
    const host = makeChatPageHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.steer": () =>
          ++attempts === 1 ? { status: "queued", reason: "Old refusal" } : retryResponse.promise,
        "chat.history": () => {
          historyRequested.resolve();
          return history.promise;
        },
      },
    });
    applyChatPendingInputs(host, pendingInputs);
    const first = host.steerQueuedChatMessage(rowId);
    await historyRequested.promise;
    let retry: Promise<void> | undefined;
    try {
      expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
      expect(getChatHistoryLoadState(host).phase).toBe("in-flight");
      retry = host.steerQueuedChatMessage(rowId);
      expect(getChatPendingInputs(host)?.steeringRunIds.has(input.runId!)).toBe(true);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.steer")).toEqual([
        ["chat.steer", { sessionKey, sessionId, agentId: "main", runId: input.runId }],
        ["chat.steer", { sessionKey, sessionId, agentId: "main", runId: input.runId }],
      ]);
      history.resolve({ sessionId, messages: [], pendingInputs });
      await first;
      // Old history settlement must not clear the retry's still-pending RPC.
      expect(getChatPendingInputs(host)?.steeringRunIds.has(input.runId!)).toBe(true);
      expect(host.chatError).toBeNull();
    } finally {
      history.resolve({ sessionId, messages: [], pendingInputs });
      retryResponse.resolve({ status: "accepted" });
      await Promise.all([first, retry]);
    }
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("keeps a newer control failure when an older Steer succeeds", async () => {
    const older = createDeferred<ChatSteerResult>();
    let attempts = 0;
    const host = createHost(() =>
      ++attempts === 1 ? older.promise : Promise.reject(new Error("Newer control failure")),
    );
    applyChatPendingInputs(host, {
      items: [queued, { ...queued, id: "second", runId: "second-run" }],
      total: 2,
      queuedCount: 2,
    });
    const first = host.steerQueuedChatMessage(rowId);
    await host.steerQueuedChatMessage("pending-input:second");
    expect(host.chatError).toBe("Newer control failure");
    older.resolve({ status: "accepted" });
    await first;
    expect(host.chatError).toBe("Newer control failure");
    expect(host.lastError).toBe(host.chatError);
  });

  it("does not publish an older refusal after a newer Steer succeeded", async () => {
    const older = createDeferred<ChatSteerResult>();
    let attempts = 0;
    const host = createHost(() => (++attempts === 1 ? older.promise : { status: "accepted" }));
    applyChatPendingInputs(host, {
      items: [queued, { ...queued, id: "second", runId: "second-run" }],
      total: 2,
      queuedCount: 2,
    });
    const first = host.steerQueuedChatMessage(rowId);
    await host.steerQueuedChatMessage("pending-input:second");
    older.resolve({ status: "queued", reason: "Older refusal" });
    await first;
    expect(host.chatError).toBeNull();
  });

  it.each(["accepted", "queued", "rejected"] as const)(
    "does not replace a newer unrelated error after a %s response",
    async (outcome) => {
      const response = createDeferred<ChatSteerResult>();
      const host = createHost(() => response.promise);
      const steering = host.steerQueuedChatMessage(rowId);
      setChatError(host, "A newer send failed");
      if (outcome === "rejected") {
        response.reject(new Error("Old control failure"));
      } else {
        response.resolve(
          outcome === "queued"
            ? { status: "queued", reason: "Old refusal" }
            : { status: "accepted" },
        );
      }
      await steering;
      expect(host.chatError).toBe("A newer send failed");
      expect(host.lastError).toBe(host.chatError);
    },
  );

  it("does not report a declined input as queued after authoritative consumption", async () => {
    const host = makeChatPageHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.steer": { status: "queued", reason: "It remains queued" },
        "chat.history": {
          sessionId,
          messages: [],
          pendingInputs: { items: [], total: 0, queuedCount: 0 },
        },
      },
    });
    applyChatPendingInputs(host, pendingInputs);
    await host.steerQueuedChatMessage(rowId);
    expect(getChatPendingInputs(host)?.queuedInputs).toEqual([]);
    expect(host.chatError).toBeNull();
  });

  it("preserves the draft and mentions behind input-history recall while reconciling Steer", async () => {
    const host = createHost();
    host.chatMessages = [{ role: "user", content: "Previous prompt", timestamp: 1 }];
    host.chatMessage = "@Alex unfinished draft";
    const mentions = [{ profileId: "alex", start: 0, end: 5 }];
    host.chatMentions = mentions;
    const recall = (key: "ArrowUp" | "ArrowDown") =>
      handleChatInputHistoryKey(host, {
        key,
        selectionStart: 0,
        selectionEnd: 0,
        valueLength: host.chatMessage.length,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 0,
      });
    expect(recall("ArrowUp").handled).toBe(true);
    expect(host.chatMessage).toBe("Previous prompt");
    await host.steerQueuedChatMessage(rowId);
    expect(recall("ArrowDown").handled).toBe(true);
    expect(host.chatMessage).toBe("@Alex unfinished draft");
    expect(host.chatMentions).toEqual(mentions);
  });

  it("reports an unsupported dev Gateway method visibly without resending the input", async () => {
    const host = createHost(() => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: chat.steer",
      });
    });
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toBe("unknown method: chat.steer");
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
    expect(host.request.mock.calls.map(([method]) => method)).toEqual(["chat.steer"]);
  });

  it("clears only its own refusal on explicit retry", async () => {
    let attempts = 0;
    const host = createHost(() =>
      ++attempts === 1 ? { status: "queued", reason: "Cannot steer yet" } : { status: "accepted" },
    );
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toBe("Cannot steer yet");
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toBeNull();
  });

  it.each(["failed", "newer-error", "reconnect"] as const)(
    "settles busy state safely when reconciliation is %s",
    async (outcome) => {
      const history = createDeferred<unknown>();
      const requested = createDeferred();
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.steer": { status: "queued", reason: "Old refusal" },
          "chat.history": () => {
            requested.resolve();
            return history.promise;
          },
        },
      });
      applyChatPendingInputs(host, pendingInputs);
      const steering = host.steerQueuedChatMessage(rowId);
      await requested.promise;
      expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.steer")).toHaveLength(1);
      if (outcome === "reconnect") {
        host.connectionEpoch += 1;
      }
      if (outcome !== "failed") {
        setChatError(host, "Newer connection or send error");
        history.resolve({ sessionId, messages: [], pendingInputs });
      } else {
        history.reject(new Error("History unavailable"));
      }
      await steering;
      expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
      expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
      if (outcome === "failed") {
        expect(getChatHistoryLoadState(host)).toMatchObject({
          phase: "failed",
          message: "History unavailable",
        });
      } else {
        expect(host.chatError).toBe("Newer connection or send error");
      }
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    },
  );

  it("targets admitted input by exact identity without copying its text or attachments", async () => {
    const host = createHost();
    applyChatPendingInputs(host, {
      ...pendingInputs,
      items: [
        {
          ...queued,
          message: {
            role: "user",
            content: "Display-only body",
            media: [{ url: "/media/source.png", contentType: "image/png" }],
          },
        },
      ],
    });
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).toHaveBeenCalledWith("chat.steer", {
      sessionKey,
      sessionId,
      agentId: "main",
      runId: input.runId,
    });
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([]);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
  });

  it("coalesces duplicate clicks and retains the row until authoritative consumption", async () => {
    const response = createDeferred<ChatSteerResult>();
    const host = createHost(() => response.promise);
    const first = host.steerQueuedChatMessage(rowId);
    const second = host.steerQueuedChatMessage(rowId);
    expect(getChatPendingInputs(host)?.steeringRunIds.has(input.runId!)).toBe(true);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.steer")).toHaveLength(1);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    response.resolve({ status: "accepted" });
    await Promise.all([first, second]);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(0);
  });

  it("keeps failed steering queued and shows the current failure", async () => {
    const host = createHost(() => {
      throw new Error("The active run cannot accept this input; it remains queued.");
    });
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toContain("it remains queued");
    expect(host.lastError).toBe(host.chatError);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });

  it.each(["session", "incarnation", "agent", "connection", "epoch", "disposal"] as const)(
    "does not publish a late control response into a changed %s",
    async (change) => {
      const response = createDeferred<ChatSteerResult>();
      const host = createHost(() => response.promise);
      if (change === "agent") {
        host.sessionKey = "global";
        host.assistantAgentId = "main";
        applyChatPendingInputs(host, pendingInputs);
      }
      const steering = host.steerQueuedChatMessage(rowId);
      if (change === "session") {
        host.sessionKey = "agent:main:other";
      }
      if (change === "incarnation") {
        host.currentSessionId = "replacement-session";
      }
      if (change === "agent") {
        host.assistantAgentId = "other";
      }
      if (change === "connection") {
        host.client = null;
      }
      if (change === "epoch") {
        host.connectionEpoch += 1;
      }
      if (change === "disposal") {
        disposeSelectedSessionMessageSubscription(host);
      }
      host.chatError = "New conversation error";
      response.resolve({ status: "queued", reason: "Old control failure" });
      await steering;
      expect(host.chatError).toBe("New conversation error");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
        0,
      );
    },
  );

  it("explains a declined promotion without discarding or resending the original input", async () => {
    const host = createHost(() => ({
      status: "queued",
      reason: "The runtime is compacting. The message remains queued.",
    }));
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toContain("remains queued");
    expect(host.lastError).toBe(host.chatError);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });

  it("does not dispatch while disconnected or for an already retired queue row", async () => {
    const host = createHost();
    host.connected = false;
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).not.toHaveBeenCalled();
    host.connected = true;
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatError).toBeNull();
  });
});
