// @vitest-environment node
import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";

function admissionFixture() {
  const key = "agent:main:selected";
  const requested = createDeferred();
  const admitted = createDeferred<{ key: string; agentId: string }>();
  const messages: unknown[] = [];
  const state = makeChatHost({
    sessionKey: key,
    requestHandlers: {
      "sessions.messages.subscribe": (params: { mode?: string }) => {
        if (params.mode === "narration") {
          return { key, agentId: "main" };
        }
        requested.resolve();
        return admitted.promise;
      },
      "chat.history": () => ({ messages }),
      "chat.startup": () => ({ messages }),
    },
  });
  onTestFinished(() => state.sessions.dispose());
  return { state, key, requested, admitted, messages };
}

describe("foreground history subscription admission", () => {
  it.each([false, true])(
    "reads pre-admission activity after the full-stream upgrade ACK (startup: %s)",
    async (startup) => {
      const { state, key, requested, admitted, messages } = admissionFixture();
      await state.sessions.subscribeMessages(key, { mode: "narration" });
      const subscription = syncSelectedSessionMessageSubscription(state);
      const history = loadChatHistory(state, { startup, deferBranches: true });
      await requested.promise;
      const method = startup ? "chat.startup" : "chat.history";
      expect(requestCalls(state.request, method)).toHaveLength(0);
      expect(state.chatLoading).toBe(true);

      const missedMessage = { role: "assistant", content: "Completed before stream admission." };
      messages.push(missedMessage);
      admitted.resolve({ key, agentId: "main" });
      await Promise.all([subscription, history]);

      expect(requestCalls(state.request, method)).toHaveLength(1);
      expect(state.chatMessages).toEqual([missedMessage]);
      expect(getChatHistoryLoadState(state).phase).toBe("committed");
    },
  );

  it.each(["selection", "connection"])(
    "retires the history read when %s changes before stream admission",
    async (change) => {
      const { state, key, requested, admitted } = admissionFixture();
      const subscription = syncSelectedSessionMessageSubscription(state);
      const history = loadChatHistory(state, { startup: true, deferBranches: true });
      await requested.promise;
      if (change === "selection") {
        state.sessionKey = "agent:main:replacement";
      } else {
        state.connectionEpoch += 1;
      }
      admitted.resolve({ key, agentId: "main" });
      await Promise.all([subscription, history]);

      expect(requestCalls(state.request, "chat.startup")).toHaveLength(0);
      expect(state.chatMessages).toEqual([]);
    },
  );

  it("settles a rejected admission visibly without reading an incomplete transcript", async () => {
    const { state, requested, admitted } = admissionFixture();
    const subscription = syncSelectedSessionMessageSubscription(state);
    const history = loadChatHistory(state, { startup: true, deferBranches: true });
    await requested.promise;
    admitted.reject(new Error("Live stream subscription failed"));
    await Promise.all([subscription, history]);

    expect(requestCalls(state.request, "chat.startup")).toHaveLength(0);
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      message: "Live stream subscription failed",
      startup: true,
    });
    expect(state.chatLoading).toBe(false);
    expect(state.chatError).toBe("Live stream subscription failed");
  });

  it("retires an acknowledged admission before a queued history read can issue", async () => {
    const { state, key, requested, admitted } = admissionFixture();
    const subscription = syncSelectedSessionMessageSubscription(state);
    await requested.promise;
    admitted.resolve({ key, agentId: "main" });
    await expect(subscription).resolves.toBe(true);

    const history = loadChatHistory(state, { startup: true, deferBranches: true });
    disposeSelectedSessionMessageSubscription(state);
    await history;

    expect(requestCalls(state.request, "chat.startup")).toHaveLength(0);
    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(state.chatMessages).toEqual([]);
  });
});
