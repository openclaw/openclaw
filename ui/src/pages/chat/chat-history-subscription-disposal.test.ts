// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import type { ChatState } from "./chat-state-contract.ts";

const subscription = { key: "agent:main:main", agentId: null };

function createSubscriptionState(
  unsubscribeMessages: ReturnType<typeof vi.fn<SessionCapability["unsubscribeMessages"]>>,
  subscribeMessages: ReturnType<typeof vi.fn<SessionCapability["subscribeMessages"]>> = vi.fn<
    SessionCapability["subscribeMessages"]
  >(),
): ChatState & {
  sessions: Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;
} {
  return {
    client: {} as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: subscription.key,
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    hello: null,
    sessions: { subscribeMessages, unsubscribeMessages },
  };
}

describe("disposed chat message subscriptions", () => {
  afterEach(() => vi.useRealTimers());

  it("releases an active message subscription when its pane is disposed", () => {
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockResolvedValue(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscriptionRequestedKey = subscription.key;
    state.chatSessionMessageSubscription = subscription;
    state.chatSessionApprovalQueue = [
      {
        id: "approval-1",
        kind: "plugin",
        request: { command: "Approve", sessionKey: subscription.key },
        createdAtMs: 1,
        expiresAtMs: 2,
      },
    ];

    disposeSelectedSessionMessageSubscription(state);

    expect(unsubscribeMessages).toHaveBeenCalledExactlyOnceWith(subscription);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBeNull();
    expect(state.chatSessionMessageSubscription).toBeNull();
    expect(state.chatSessionApprovalQueue).toEqual([]);
  });

  it.each([false, true])(
    "releases a subscription that resolves after its pane is disposed (initial release fails: %s)",
    async (failInitialRelease) => {
      vi.useFakeTimers();
      const subscribeStarted = createDeferred();
      const pendingSubscription = createDeferred<typeof subscription>();
      const unsubscribeMessages = vi
        .fn<SessionCapability["unsubscribeMessages"]>()
        .mockResolvedValue(undefined);
      if (failInitialRelease) {
        unsubscribeMessages.mockRejectedValueOnce(new Error("temporary observer release failure"));
      }
      const state = createSubscriptionState(
        unsubscribeMessages,
        vi.fn<SessionCapability["subscribeMessages"]>().mockImplementation(() => {
          subscribeStarted.resolve(undefined);
          return pendingSubscription.promise;
        }),
      );

      const sync = syncSelectedSessionMessageSubscription(state);
      await subscribeStarted.promise;
      disposeSelectedSessionMessageSubscription(state);
      pendingSubscription.resolve(subscription);
      await vi.runAllTimersAsync();
      await sync;

      expect(unsubscribeMessages).toHaveBeenCalledTimes(failInitialRelease ? 2 : 1);
      for (const [released] of unsubscribeMessages.mock.calls) {
        expect(released).toBe(subscription);
      }
      expect(state.chatSessionMessageSubscription).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["before-acquire", "during-compensation"])(
    "retries replacement rollback after disposal %s without another pane sync",
    async (disposeAt) => {
      vi.useFakeTimers();
      const previous = { key: "agent:main:previous", agentId: null };
      const replacement = { key: "agent:main:replacement", agentId: null };
      const acquireStarted = createDeferred();
      const acquire = createDeferred<typeof replacement>();
      const compensationStarted = createDeferred();
      const compensation = createDeferred();
      let previousFailed = false;
      let replacementFailed = false;
      const unsubscribeMessages = vi
        .fn<SessionCapability["unsubscribeMessages"]>()
        .mockImplementation(async (handle) => {
          if (handle === previous && !previousFailed) {
            previousFailed = true;
            throw new Error("previous release failed");
          }
          if (handle === replacement && !replacementFailed) {
            replacementFailed = true;
            compensationStarted.resolve();
            await compensation.promise;
          }
        });
      const state = createSubscriptionState(
        unsubscribeMessages,
        vi.fn<SessionCapability["subscribeMessages"]>().mockImplementation(() => {
          acquireStarted.resolve();
          return acquire.promise;
        }),
      );
      state.sessionKey = replacement.key;
      state.chatSessionMessageSubscriptionRequestedKey = previous.key;
      state.chatSessionMessageSubscription = previous;

      const sync = syncSelectedSessionMessageSubscription(state);
      await acquireStarted.promise;
      if (disposeAt === "before-acquire") {
        disposeSelectedSessionMessageSubscription(state);
      }
      acquire.resolve(replacement);
      await compensationStarted.promise;
      if (disposeAt === "during-compensation") {
        disposeSelectedSessionMessageSubscription(state);
      }
      compensation.reject(new Error("temporary replacement release failure"));
      await vi.runAllTimersAsync();
      await sync;

      expect(
        unsubscribeMessages.mock.calls.filter(([handle]) => handle === replacement),
      ).toHaveLength(2);
      expect(unsubscribeMessages).toHaveBeenLastCalledWith(replacement);
      expect(state.chatSessionMessageSubscriptionRequestedKey).toBeNull();
      expect(state.chatSessionMessageSubscription).toBeNull();
      expect(state.chatSessionApprovalQueue).toEqual([]);
      expect(state.lastError).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries a temporary release failure without another pane synchronization", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValueOnce(new Error("temporary observer release failure"))
      .mockResolvedValueOnce(undefined);
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(250);

    expect(unsubscribeMessages).toHaveBeenCalledTimes(2);
    expect(unsubscribeMessages).toHaveBeenLastCalledWith(subscription);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });

  it("bounds permanently failing releases without leaking retry timers", async () => {
    vi.useFakeTimers();
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
      .mockRejectedValue(new Error("observer unavailable"));
    const state = createSubscriptionState(unsubscribeMessages);
    state.chatSessionMessageSubscription = subscription;

    disposeSelectedSessionMessageSubscription(state);
    await vi.runAllTimersAsync();

    expect(unsubscribeMessages).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(state.chatSessionMessageSubscription).toBeNull();
  });
});
