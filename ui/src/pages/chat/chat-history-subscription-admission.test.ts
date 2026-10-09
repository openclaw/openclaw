// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  state.chatError = null;
  onTestFinished(() => state.sessions.dispose());
  return { state, key, requested, admitted, messages };
}

describe("foreground history subscription admission", () => {
  it("retries a compensated subscription timeout before history without replacing cached input", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const key = "agent:main:timeout-recovery";
    const cached = [{ role: "assistant", content: "Cached conversation" }];
    let attempts = 0;
    const compensated = createDeferred();
    const state = makeChatHost({
      sessionKey: key,
      chatMessages: cached,
      chatMessage: "Unsent draft",
      requestHandlers: {
        "sessions.messages.subscribe": () => {
          attempts += 1;
          if (attempts === 1) {
            throw new GatewayProtocolRequestTimeoutError({
              method: "sessions.messages.subscribe",
              timeoutMs: 30_000,
              requestSent: true,
            });
          }
          return { key, agentId: "main" };
        },
        "sessions.messages.unsubscribe": () => {
          compensated.resolve();
          return {};
        },
        "chat.startup": () => ({ messages: cached }),
      },
    });
    state.chatError = null;
    onTestFinished(() => state.sessions.dispose());
    const subscription = syncSelectedSessionMessageSubscription(state);
    const history = loadChatHistory(state, { startup: true, deferBranches: true });
    await compensated.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(requestCalls(state.request, "sessions.messages.unsubscribe")).toHaveLength(1);
    expect(requestCalls(state.request, "chat.startup")).toHaveLength(0);
    expect(state.chatMessages).toEqual(cached);
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
    state.chatMessage = "Newer draft while recovering";
    await vi.advanceTimersByTimeAsync(500);
    await expect(subscription).resolves.toBe(true);
    await history;
    expect(attempts).toBe(2);
    expect(requestCalls(state.request, "chat.startup")).toHaveLength(1);
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
    expect(state.chatMessage).toBe("Newer draft while recovering");
    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

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

  it.each(["selection", "connection", "rejected", "disposed"])(
    "withholds history when stream admission is %s",
    async (change) => {
      const { state, key, requested, admitted } = admissionFixture();
      const subscription = syncSelectedSessionMessageSubscription(state);
      if (change === "disposed") {
        await requested.promise;
        admitted.resolve({ key, agentId: "main" });
        await expect(subscription).resolves.toBe(true);
      }
      const history = loadChatHistory(state, { startup: true, deferBranches: true });
      if (change !== "disposed") {
        await requested.promise;
      }
      if (change === "selection") {
        state.sessionKey = "agent:main:replacement";
      } else if (change === "connection") {
        state.connectionEpoch += 1;
      }
      if (change === "rejected") {
        admitted.reject(new Error("Live stream subscription failed"));
      } else if (change === "disposed") {
        disposeSelectedSessionMessageSubscription(state);
      } else {
        admitted.resolve({ key, agentId: "main" });
      }
      await Promise.all([subscription, history]);

      expect(requestCalls(state.request, "chat.startup")).toHaveLength(0);
      expect(state.chatMessages).toEqual([]);
      if (change === "rejected") {
        expect(getChatHistoryLoadState(state)).toMatchObject({
          phase: "failed",
          message: "Live stream subscription failed",
          startup: true,
        });
        expect(state.chatLoading).toBe(false);
        expect(state.chatError).toBeNull();
        expect(state.lastError).toBeNull();
      } else if (change === "disposed") {
        expect(state.chatSessionMessageSubscription).toBeNull();
      }
    },
  );
});
