// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { useFakeClock } from "../../test-helpers/fake-clock.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost, requestCalls } from "./chat-host.test-support.ts";

it.each<[string, boolean]>([
  ["timeout", true],
  ["session changed", true],
  ["upgraded", false],
  ["upgraded", true],
  ["selection", true],
  ["connection", true],
  ["rejected", true],
  ["disposed", true],
])("fences history behind stream admission: %s (startup: %s)", async (change, startup) => {
  const retry = change === "timeout" || change === "session changed";
  const succeeds = retry || change === "upgraded";
  if (retry) {
    useFakeClock();
  }
  const cached = retry ? [{ role: "assistant", content: "Cached conversation" }] : [];
  const completed = [...cached, { role: "assistant", content: "Completed before admission." }];
  const key = "agent:main:selected";
  const rpc = "sessions.messages.subscribe";
  const failure = "Live stream subscription failed";
  const timeout = { method: rpc, timeoutMs: 30_000, requestSent: true };
  const requested = createDeferred();
  const admitted = createDeferred<{ key: string; agentId: string }>();
  const messages: unknown[] = retry ? [...completed] : [];
  let attempts = 0;
  const subscribe = () => {
    if (++attempts > 1) {
      return { key, agentId: "main" };
    }
    throw change === "session changed"
      ? new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "session changed before sessions.messages.subscribe; retry the request",
          details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED", method: rpc },
        })
      : new GatewayProtocolRequestTimeoutError(timeout);
  };
  const state = makeChatHost({
    sessionKey: key,
    chatMessages: cached,
    chatMessage: retry ? "Unsent draft" : "",
    requestHandlers: {
      [rpc]: (params: { mode?: string }) => {
        if (params.mode === "narration") {
          return { key, agentId: "main" };
        }
        requested.resolve();
        return retry ? subscribe() : admitted.promise;
      },
      "chat.history": () => ({ messages }),
      "chat.startup": () => ({ messages }),
    },
  });
  state.chatError = null;
  onTestFinished(() => state.sessions.dispose());
  const calls = (method: string) => requestCalls(state.request, method);
  if (change === "upgraded") {
    await state.sessions.subscribeMessages(key, { mode: "narration" });
  }
  const subscription = syncSelectedSessionMessageSubscription(state);
  if (change === "disposed") {
    await requested.promise;
    admitted.resolve({ key, agentId: "main" });
    await expect(subscription).resolves.toBe(true);
  }
  const history = loadChatHistory(state, { startup, deferBranches: true });
  if (change !== "disposed") {
    await requested.promise;
  }
  const method = startup ? "chat.startup" : "chat.history";
  if (retry) {
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("sessions.messages.unsubscribe")).toHaveLength(0);
    expect(state.chatMessages).toEqual(cached);
    expect(state).toMatchObject({ chatError: null, lastError: null });
  }
  expect(calls(method)).toHaveLength(0);
  if (change === "upgraded") {
    expect(state.chatLoading).toBe(true);
    messages.push(...completed);
  }
  if (change === "selection") {
    state.sessionKey = "agent:main:replacement";
  } else if (change === "connection") {
    state.connectionEpoch += 1;
  }
  if (change === "rejected") {
    admitted.reject(new Error(failure));
  } else if (change === "disposed") {
    disposeSelectedSessionMessageSubscription(state);
  } else if (retry) {
    state.chatMessage = "Newer draft while recovering";
    await vi.advanceTimersByTimeAsync(500);
    await expect(subscription).resolves.toBe(true);
  } else {
    admitted.resolve({ key, agentId: "main" });
  }
  await Promise.all([subscription, history]);

  const load = getChatHistoryLoadState(state);
  expect(calls(method)).toHaveLength(succeeds ? 1 : 0);
  expect(state.chatMessages).toEqual(succeeds ? completed : []);
  if (succeeds) {
    expect(load.phase).toBe("committed");
  }
  if (retry) {
    expect([attempts, state.chatMessage]).toEqual([2, "Newer draft while recovering"]);
    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  }
  if (change === "rejected") {
    expect(load).toMatchObject({ phase: "failed", message: failure, startup });
    expect(state).toMatchObject({ chatLoading: false, chatError: null, lastError: null });
  } else if (change === "disposed") {
    expect(state.chatSessionMessageSubscription).toBeNull();
  }
});
