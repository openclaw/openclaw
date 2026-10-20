// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";

function admissionFixture(subscribe?: (key: string) => unknown, cached: unknown[] = []) {
  const key = "agent:main:selected";
  const requested = createDeferred();
  const admitted = createDeferred<{ key: string; agentId: string }>();
  const messages: unknown[] = [];
  const state = makeChatHost({
    sessionKey: key,
    chatMessages: cached,
    chatMessage: subscribe ? "Unsent draft" : "",
    requestHandlers: {
      "sessions.messages.subscribe": (params: { mode?: string }) => {
        if (params.mode === "narration") {
          return { key, agentId: "main" };
        }
        requested.resolve();
        return subscribe ? subscribe(key) : admitted.promise;
      },
      "chat.history": () => ({ messages }),
      "chat.startup": () => ({ messages }),
    },
  });
  state.chatError = null;
  onTestFinished(() => state.sessions.dispose());
  return {
    state,
    key,
    requested,
    admitted,
    messages,
    calls: (method: string) => requestCalls(state.request, method),
  };
}

it.each(["timeout", "session changed"])(
  "retries %s before history without replacing cached input",
  async (failure) => {
    vi.useFakeTimers();
    onTestFinished(() => vi.useRealTimers());
    const cached = [{ role: "assistant", content: "Cached conversation" }];
    const completed = [
      ...cached,
      { role: "assistant", content: "Completed while admission changed." },
    ];
    let attempts = 0;
    const { state, requested, messages, calls } = admissionFixture((key) => {
      if (++attempts > 1) {
        return { key, agentId: "main" };
      }
      throw failure === "session changed"
        ? new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "session changed before sessions.messages.subscribe; retry the request",
            details: {
              code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
              method: "sessions.messages.subscribe",
              sessionKey: key,
            },
          })
        : new GatewayProtocolRequestTimeoutError({
            method: "sessions.messages.subscribe",
            timeoutMs: 30_000,
            requestSent: true,
          });
    }, cached);
    messages.push(...completed);
    const subscription = syncSelectedSessionMessageSubscription(state);
    const history = loadChatHistory(state, { startup: true, deferBranches: true });
    await requested.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("sessions.messages.unsubscribe")).toHaveLength(0);
    expect(calls("chat.startup")).toHaveLength(0);
    expect(state.chatMessages).toEqual(cached);
    expect(state).toMatchObject({ chatError: null, lastError: null });
    state.chatMessage = "Newer draft while recovering";
    await vi.advanceTimersByTimeAsync(500);
    await expect(subscription).resolves.toBe(true);
    await history;
    expect(attempts).toBe(2);
    expect(calls("chat.startup")).toHaveLength(1);
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
    expect(state.chatMessages).toEqual(completed);
    expect(state.chatMessage).toBe("Newer draft while recovering");
    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([false, true])(
  "reads pre-admission activity after the full-stream upgrade ACK (startup: %s)",
  async (startup) => {
    const { state, key, requested, admitted, messages, calls } = admissionFixture();
    await state.sessions.subscribeMessages(key, { mode: "narration" });
    const subscription = syncSelectedSessionMessageSubscription(state);
    const history = loadChatHistory(state, { startup, deferBranches: true });
    await requested.promise;
    const method = startup ? "chat.startup" : "chat.history";
    expect(calls(method)).toHaveLength(0);
    expect(state.chatLoading).toBe(true);

    const missedMessage = { role: "assistant", content: "Completed before stream admission." };
    messages.push(missedMessage);
    admitted.resolve({ key, agentId: "main" });
    await Promise.all([subscription, history]);

    expect(calls(method)).toHaveLength(1);
    expect(state.chatMessages).toEqual([missedMessage]);
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
  },
);

it.each(["selection", "connection", "rejected", "disposed"])(
  "withholds history when stream admission is %s",
  async (change) => {
    const { state, key, requested, admitted, calls } = admissionFixture();
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

    expect(calls("chat.startup")).toHaveLength(0);
    expect(state.chatMessages).toEqual([]);
    if (change === "rejected") {
      expect(getChatHistoryLoadState(state)).toMatchObject({
        phase: "failed",
        message: "Live stream subscription failed",
        startup: true,
      });
      expect(state).toMatchObject({ chatLoading: false, chatError: null, lastError: null });
    } else if (change === "disposed") {
      expect(state.chatSessionMessageSubscription).toBeNull();
    }
  },
);
