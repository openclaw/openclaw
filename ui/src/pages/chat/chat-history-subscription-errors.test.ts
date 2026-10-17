// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

type Subscription = Awaited<ReturnType<SessionCapability["subscribeMessages"]>>;
type Subscribe = SessionCapability["subscribeMessages"];
type Unsubscribe = SessionCapability["unsubscribeMessages"];
const subscriptionTimeout = () =>
  vi.fn<Subscribe>().mockRejectedValue(
    new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: 30_000,
      requestSent: true,
    }),
  );

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
  const state = {
    ...makeChatHost({ requestHandlers: {}, sessionKey: selected.key }),
    connectionEpoch: 1,
    chatError: null as string | null,
    chatSessionMessageSubscriptionRequestedKey: options?.previous?.key ?? null,
    chatSessionMessageSubscription: options?.previous ?? null,
    sessions: { subscribeMessages, unsubscribeMessages },
    requestUpdate: vi.fn(),
  } satisfies Parameters<typeof syncSelectedSessionMessageSubscription>[0];

  return { selected, state, subscribeMessages, unsubscribeMessages };
}

it.each(["dispose", "selection", "capability", "deadline"] as const)(
  "settles transient subscription recovery on %s without touching drafts",
  async (change) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const subscribeMessages = subscriptionTimeout();
    const { state } = createSubscriptionState({ subscribeMessages });
    state.chatMessage = "New unsent draft";
    const pending = syncSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeMessages).toHaveBeenCalledTimes(1);
    if (change === "dispose") {
      disposeSelectedSessionMessageSubscription(state);
      expect(vi.getTimerCount()).toBe(0);
    } else if (change === "selection") {
      state.sessionKey = "agent:main:new";
    } else if (change === "capability") {
      state.sessions = { subscribeMessages: vi.fn(), unsubscribeMessages: vi.fn() };
    }
    await vi.advanceTimersByTimeAsync(change === "deadline" ? 60_000 : 500);
    await expect(pending).resolves.toBe(false);
    if (change === "deadline") {
      expect(subscribeMessages.mock.calls.length).toBeGreaterThan(1);
      expect(subscribeMessages.mock.calls.length).toBeLessThan(20);
      expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "failed", retryable: true });
      expect(state.sessionsError).toBeNull();
    } else {
      expect(subscribeMessages).toHaveBeenCalledTimes(1);
    }
    expect(state.chatMessage).toBe("New unsent draft");
    expect(state).toMatchObject({ lastError: null, chatError: null });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps a successful replacement and warns when the previous release fails", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warning.mockRestore());
  const previous = { key: "agent:main:previous", agentId: null } satisfies Subscription;
  const unsubscribeMessages = vi
    .fn<Unsubscribe>()
    .mockRejectedValueOnce(new Error("Previous observer release failed"))
    .mockResolvedValueOnce(undefined);
  const { selected, state } = createSubscriptionState({ previous, unsubscribeMessages });

  await expect(syncSelectedSessionMessageSubscription(state)).resolves.toBe(true);

  expect(state.chatSessionMessageSubscription).toBe(selected);
  expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(previous);
  expect(warning).toHaveBeenCalledOnce();
  expect(getChatHistoryLoadState(state)).toMatchObject({
    phase: "failed",
    message: "Previous observer release failed",
  });
  expect(state).toMatchObject({ lastError: null, chatError: null });
  expect(state.requestUpdate).toHaveBeenCalledOnce();
  state.lastError = "Sending the message failed";
  state.chatError = "Sending the message failed";
  state.sessionsError = "Session list refresh failed";

  await syncSelectedSessionMessageSubscription(state);

  expect(state.chatSessionMessageSubscription).toEqual(selected);
  expect(getChatHistoryLoadState(state).phase).toBe("idle");
  expect(state).toMatchObject({
    lastError: "Sending the message failed",
    chatError: "Sending the message failed",
    sessionsError: "Session list refresh failed",
  });
  expect(unsubscribeMessages).toHaveBeenCalledOnce();
});

it.each(["dispose", "reconnect"])(
  "never publishes a failed subscription after %s",
  async (change) => {
    const pending = createDeferred<Subscription>();
    const { state } = createSubscriptionState({
      subscribeMessages: vi.fn<Subscribe>(() => pending.promise),
    });

    const sync = syncSelectedSessionMessageSubscription(state);
    await Promise.resolve();
    if (change === "dispose") {
      disposeSelectedSessionMessageSubscription(state);
    } else {
      state.connectionEpoch += 1;
    }
    pending.reject(new Error("Retired observer unavailable"));
    await sync;

    expect(state).toMatchObject({ lastError: null, chatError: null });
    expect(state.requestUpdate).not.toHaveBeenCalled();
  },
);
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
  state.chatSessionApprovalQueue = [
    {
      id: "stale-main-approval",
      kind: "exec" as const,
      request: { command: "echo stale", agentId: "main", sessionKey: "global" },
      createdAtMs: 1,
      expiresAtMs: 10_000,
    },
  ];

  const sync = syncSelectedSessionMessageSubscription(state);
  await Promise.resolve();
  const queueWhileReplacementIsPending = [...state.chatSessionApprovalQueue];
  pending.resolve({
    key: "global",
    agentId: "research",
    includeApprovals: true,
    approvalReplay: {
      sessionKey: "agent:research:global",
      updatedAtMs: 2,
      approvals: [],
      truncated: false,
    },
  });
  await sync;

  expect(queueWhileReplacementIsPending).toEqual([]);
  expect(subscribeMessages).toHaveBeenCalledWith("global", {
    agentId: "research",
    includeApprovals: true,
  });
});
