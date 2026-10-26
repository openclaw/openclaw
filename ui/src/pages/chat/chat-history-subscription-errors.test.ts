// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { useFakeClock } from "../../test-helpers/fake-clock.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import {
  chatHistoryRequests,
  getAcceptedChatHistorySession as acceptedHistory,
  getChatHistoryLoadState as historyLoad,
  resetChatHistoryProjection,
  setChatHistoryLoad,
} from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription as disposeSubscription,
  syncSelectedSessionMessageSubscription as syncSubscription,
} from "./chat-history-subscription.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

type Subscription = Awaited<ReturnType<SessionCapability["subscribeMessages"]>>;
type Subscribe = SessionCapability["subscribeMessages"];
type Unsubscribe = SessionCapability["unsubscribeMessages"];
const previousSubscription = { key: "agent:main:previous", agentId: null };
function observe<T>(read: () => T) {
  const values: T[] = [];
  onTestFinished(
    createRoot((stop) => {
      createEffect(read, (value) => {
        values.push(value);
      });
      return stop;
    }),
  );
  flush();
  return values;
}
function silenceReleaseWarning() {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warning.mockRestore());
  return warning;
}
const approval = (sessionKey: string) => ({
  id: "approval",
  kind: "exec" as const,
  request: { command: "Approve", agentId: "main", sessionKey },
  createdAtMs: 1,
  expiresAtMs: 10_000,
});
const sessionChanged = (overrides: { code?: string; details?: unknown } = {}) =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "session changed before sessions.messages.subscribe; retry the request",
    details: {
      code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
      method: "sessions.messages.subscribe",
      sessionKey: "agent:main:selected",
    },
    ...overrides,
  });

function createSubscriptionState(options?: {
  sessionKey?: string;
  previous?: Subscription;
  subscribeMessages?: ReturnType<typeof vi.fn<Subscribe>>;
  unsubscribeMessages?: ReturnType<typeof vi.fn<Unsubscribe>>;
}) {
  const key = options?.sessionKey ?? "agent:main:selected";
  const selected = { key, agentId: null } satisfies Subscription;
  const subscribeMessages = options?.subscribeMessages ?? vi.fn<Subscribe>(async () => selected);
  const unsubscribeMessages =
    options?.unsubscribeMessages ?? vi.fn<Unsubscribe>(async () => undefined);
  const host = makeChatHost({ requestHandlers: {}, sessionKey: selected.key });
  const state = {
    ...host,
    connectionEpoch: 1,
    chatError: null as string | null,
    chatSessionMessageSubscriptionRequestedKey: options?.previous?.key ?? null,
    chatSessionMessageSubscription: options?.previous ?? null,
    sessions: { ...host.sessions, subscribeMessages, unsubscribeMessages },
  } satisfies Parameters<typeof syncSubscription>[0];
  onTestFinished(
    createRoot((stop) => {
      projectChatFields(chatHistoryRequests(state), ["historyLoad", "acceptedHistory"]);
      return stop;
    }),
  );
  const publishedLoads = observe(() => historyLoad(state).phase);
  return { selected, state, subscribeMessages, unsubscribeMessages, publishedLoads };
}

it("makes the new subscription ready before the old unsubscribe settles", async () => {
  const release = createDeferred();
  const { state, selected, unsubscribeMessages } = createSubscriptionState({
    previous: previousSubscription,
    unsubscribeMessages: vi.fn(() => release.promise),
  });
  const sync = syncSubscription(state);
  await Promise.resolve();
  expect(unsubscribeMessages).toHaveBeenCalledOnce();
  try {
    await vi.waitFor(() => expect(state.chatSessionMessageSubscription).toEqual(selected));
    await expect(sync).resolves.toBe(true);
    await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
  } finally {
    release.resolve();
    await sync;
  }
});

it("releases an active message subscription when its pane is disposed", () => {
  const { state, selected, unsubscribeMessages } = createSubscriptionState();
  state.chatSessionMessageSubscriptionRequestedKey = selected.key;
  state.chatSessionMessageSubscription = selected;
  state.chatSessionApprovalQueue = [approval(selected.key)];
  state.chatSessionApprovalReplay = {
    complete: true,
    client: state.client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
  };
  disposeSubscription(state);
  expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(selected);
  expect(state).toMatchObject({
    chatSessionApprovalReplay: undefined,
    chatSessionMessageSubscriptionRequestedKey: null,
    chatSessionMessageSubscription: null,
    chatSessionApprovalQueue: [],
  });
});

it.each([false, true])(
  "releases a subscription that resolves after its pane is disposed (initial release fails: %s)",
  async (failInitialRelease) => {
    const warning = silenceReleaseWarning();
    const requested = createDeferred();
    const pending = createDeferred<Subscription>();
    const { state, selected, unsubscribeMessages } = createSubscriptionState({
      subscribeMessages: vi.fn(() => {
        requested.resolve();
        return pending.promise;
      }),
    });
    state.hello = null;
    if (failInitialRelease) {
      unsubscribeMessages.mockRejectedValueOnce(new Error("temporary observer release failure"));
    }
    const sync = syncSubscription(state);
    await requested.promise;
    disposeSubscription(state);
    pending.resolve(selected);
    await sync;
    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(selected);
    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(warning).toHaveBeenCalledTimes(failInitialRelease ? 1 : 0);
  },
);

it.each(["dispose", "selection", "capability", "deadline"] as const)(
  "settles transient subscription recovery on %s without touching drafts",
  async (change) => {
    useFakeClock();
    const subscribeMessages = vi.fn<Subscribe>().mockRejectedValue(sessionChanged());
    const { state } = createSubscriptionState({ subscribeMessages });
    state.chatMessage = "New unsent draft";
    const pending = syncSubscription(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    if (change === "dispose") {
      disposeSubscription(state);
      expect(vi.getTimerCount()).toBe(0);
    } else if (change === "selection") {
      state.sessionKey = "agent:main:new";
    } else if (change === "capability") {
      state.sessions = {
        ...state.sessions,
        subscribeMessages: vi.fn(),
        unsubscribeMessages: vi.fn(),
      };
    }
    await vi.advanceTimersByTimeAsync(change === "deadline" ? 60_000 : 500);
    await expect(pending).resolves.toBe(false);
    if (change === "deadline") {
      expect(subscribeMessages.mock.calls.length).toBeGreaterThan(1);
      expect(subscribeMessages.mock.calls.length).toBeLessThan(20);
      expect(historyLoad(state)).toMatchObject({ phase: "failed", retryable: true });
      expect(state.sessionsError).toBeNull();
    } else {
      expect(subscribeMessages).toHaveBeenCalledTimes(1);
    }
    expect(state.chatMessage).toBe("New unsent draft");
    expect(state).toMatchObject({ lastError: null, chatError: null });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  sessionChanged({ code: "FORBIDDEN" }),
  sessionChanged({
    details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED", method: "chat.send" },
  }),
  sessionChanged({ details: { code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" } }),
  sessionChanged({ details: { code: "OTHER_ERROR", method: "sessions.messages.subscribe" } }),
  new Error("session changed before sessions.messages.subscribe; retry the request"),
])("does not retry a denial or an unqualified session-change error: %s", async (error) => {
  const subscribeMessages = vi.fn<Subscribe>().mockRejectedValue(error);
  const { state } = createSubscriptionState({ subscribeMessages });
  await expect(syncSubscription(state)).resolves.toBe(false);
  expect(subscribeMessages).toHaveBeenCalledOnce();
  expect(historyLoad(state)).toMatchObject({ phase: "failed", retryable: false });
});

it("keeps a successful replacement and warns when the previous release fails", async () => {
  const warning = silenceReleaseWarning();
  const unsubscribeMessages = vi
    .fn<Unsubscribe>()
    .mockRejectedValueOnce(new Error("Previous observer release failed"))
    .mockResolvedValueOnce(undefined);
  const { selected, state, publishedLoads } = createSubscriptionState({
    previous: previousSubscription,
    unsubscribeMessages,
  });

  await expect(syncSubscription(state)).resolves.toBe(true);

  expect(state.chatSessionMessageSubscription).toBe(selected);
  expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(previousSubscription);
  expect(warning).toHaveBeenCalledOnce();
  expect(state).toMatchObject({ lastError: null, chatError: null });
  flush();
  expect(publishedLoads).toEqual(["idle"]);
  expect(state.chatLoading).toBe(false);
  state.lastError = "Sending the message failed";
  state.chatError = "Sending the message failed";
  state.sessionsError = "Session list refresh failed";

  await syncSubscription(state);
  flush();

  expect(state.chatSessionMessageSubscription).toEqual(selected);
  expect(state).toMatchObject({
    lastError: "Sending the message failed",
    chatError: "Sending the message failed",
    sessionsError: "Session list refresh failed",
  });
  expect(unsubscribeMessages).toHaveBeenCalledOnce();
  expect(publishedLoads).toEqual(["idle"]);
  expect(state.chatLoading).toBe(false);
});

it.each(["dispose", "reconnect"])(
  "never publishes a failed subscription after %s",
  async (change) => {
    const pending = createDeferred<Subscription>();
    const { state, publishedLoads } = createSubscriptionState({
      subscribeMessages: vi.fn<Subscribe>(() => pending.promise),
    });

    const sync = syncSubscription(state);
    await Promise.resolve();
    if (change === "dispose") {
      disposeSubscription(state);
    } else {
      state.connectionEpoch += 1;
    }
    pending.reject(new Error("Retired observer unavailable"));
    await sync;

    expect(state).toMatchObject({ lastError: null, chatError: null });
    flush();
    expect(publishedLoads).toEqual(["idle"]);
  },
);
it("publishes accepted-history removal while loading stays idle", () => {
  const { state } = createSubscriptionState();
  state.currentSessionId = "accepted-session";
  const accepted = observe(() => acceptedHistory(state)?.sessionId);
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions: state.sessions,
    client: state.client!,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    requestAgentId: undefined,
    sessionInfo: {
      key: state.sessionKey,
      sessionId: "accepted-session",
      kind: "direct",
      updatedAt: 1,
    },
    sessionId: "accepted-session",
  });
  flush();
  expect(accepted).toEqual([undefined, "accepted-session"]);
  expect(state.chatLoading).toBe(false);
  resetChatHistoryProjection(state);
  flush();
  expect(accepted).toEqual([undefined, "accepted-session", undefined]);
  expect(state.chatLoading).toBe(false);
});
it("clears stale approvals while switching the selected global agent", async () => {
  const previous = { key: "global", agentId: "main", includeApprovals: true as const };
  const pending = createDeferred<Subscription>();
  const subscribeMessages = vi.fn(() => pending.promise);
  const { state } = createSubscriptionState({
    sessionKey: "global",
    previous,
    subscribeMessages,
  });
  state.assistantAgentId = "research";
  state.chatSessionApprovalQueue = [approval("global")];

  const sync = syncSubscription(state);
  await Promise.resolve();
  const queueWhileReplacementIsPending = [...state.chatSessionApprovalQueue];
  pending.resolve({ key: "global", agentId: "research" });
  await sync;

  expect(queueWhileReplacementIsPending).toEqual([]);
  expect(subscribeMessages).toHaveBeenCalledWith(
    "global",
    {
      agentId: "research",
      includeApprovals: true,
    },
    undefined,
  );
});
