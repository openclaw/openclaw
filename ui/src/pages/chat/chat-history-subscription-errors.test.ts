// @vitest-environment node
import { GatewayProtocolRequestTimeoutError } from "@openclaw/gateway-client/browser";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  disposeSelectedSessionMessageSubscription,
  syncSelectedSessionMessageSubscription,
} from "./chat-history-subscription.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

type Subscription = { key: string; agentId: null };
const subscriptionTimeout = () =>
  vi.fn<SessionCapability["subscribeMessages"]>().mockRejectedValue(
    new GatewayProtocolRequestTimeoutError({
      method: "sessions.messages.subscribe",
      timeoutMs: 30_000,
      requestSent: true,
    }),
  );
function useClock() {
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());
}
function expectNoComposerError(state: { lastError: string | null; chatError: string | null }) {
  expect(state).toMatchObject({ lastError: null, chatError: null });
}

function createSubscriptionState(options?: {
  previous?: Subscription;
  subscribeMessages?: ReturnType<typeof vi.fn<SessionCapability["subscribeMessages"]>>;
  unsubscribeMessages?: ReturnType<typeof vi.fn<SessionCapability["unsubscribeMessages"]>>;
}) {
  const selected = { key: "agent:main:selected", agentId: null } satisfies Subscription;
  const subscribeMessages =
    options?.subscribeMessages ??
    vi.fn<SessionCapability["subscribeMessages"]>(async () => selected);
  const unsubscribeMessages =
    options?.unsubscribeMessages ??
    vi.fn<SessionCapability["unsubscribeMessages"]>(async () => undefined);
  const state = {
    ...makeChatHost({ requestHandlers: {}, sessionKey: selected.key }),
    connectionEpoch: 1,
    chatError: null as string | null,
    sessionsError: null as string | null,
    chatSessionMessageSubscriptionRequestedKey: options?.previous?.key ?? null,
    chatSessionMessageSubscription: options?.previous ?? null,
    sessions: { subscribeMessages, unsubscribeMessages },
    requestUpdate: vi.fn(),
  } satisfies Parameters<typeof syncSelectedSessionMessageSubscription>[0];

  return { selected, state, subscribeMessages, unsubscribeMessages };
}

describe("visible chat message subscription failures", () => {
  it.each(["dispose", "selection", "capability"] as const)(
    "retires a delayed subscription retry on %s without touching drafts or sending requests",
    async (change) => {
      useClock();
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
      } else {
        state.sessions = { subscribeMessages: vi.fn(), unsubscribeMessages: vi.fn() };
      }
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toBe(false);
      expect(subscribeMessages).toHaveBeenCalledTimes(1);
      expect(state.chatMessage).toBe("New unsent draft");
      expectNoComposerError(state);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds repeated transient admission failures and retains one recoverable history notice", async () => {
    useClock();
    const subscribeMessages = subscriptionTimeout();
    const { state } = createSubscriptionState({ subscribeMessages });
    const pending = syncSelectedSessionMessageSubscription(state);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe(false);
    expect(subscribeMessages.mock.calls.length).toBeGreaterThan(1);
    expect(subscribeMessages.mock.calls.length).toBeLessThan(20);
    expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "failed", retryable: true });
    expectNoComposerError(state);
    expect(state.sessionsError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a successful replacement and warns when the previous release fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warning.mockRestore());
    const previous = { key: "agent:main:previous", agentId: null } satisfies Subscription;
    const unsubscribeMessages = vi
      .fn<SessionCapability["unsubscribeMessages"]>()
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
    expectNoComposerError(state);
    expect(state.requestUpdate).toHaveBeenCalledOnce();
    state.lastError = "Sending the message failed";
    state.chatError = "Sending the message failed";
    state.sessionsError = "Session list refresh failed";

    await syncSelectedSessionMessageSubscription(state);

    expect(state.chatSessionMessageSubscription).toEqual(selected);
    expect(getChatHistoryLoadState(state).phase).toBe("idle");
    expect(state.lastError).toBe("Sending the message failed");
    expect(state.chatError).toBe("Sending the message failed");
    expect(state.sessionsError).toBe("Session list refresh failed");
    expect(unsubscribeMessages).toHaveBeenCalledOnce();
  });

  it.each(["dispose", "reconnect"])(
    "never publishes a failed subscription after %s",
    async (change) => {
      const pending = createDeferred<Subscription>();
      const { state } = createSubscriptionState({
        subscribeMessages: vi.fn<SessionCapability["subscribeMessages"]>(() => pending.promise),
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

      expectNoComposerError(state);
      expect(state.requestUpdate).not.toHaveBeenCalled();
    },
  );
});

describe("selected agent subscription changes", () => {
  it("clears stale approvals while switching the selected global agent", async () => {
    const previous = { key: "global", agentId: "main", includeApprovals: true as const };
    const pending = createDeferred<Awaited<ReturnType<SessionCapability["subscribeMessages"]>>>();
    const subscribeMessages = vi.fn(() => pending.promise);
    const state = {
      ...makeChatHost({ requestHandlers: {}, sessionKey: "global" }),
      assistantAgentId: "research",
      chatSessionMessageSubscriptionRequestedKey: "global",
      chatSessionMessageSubscription: previous,
      chatSessionApprovalQueue: [
        {
          id: "stale-main-approval",
          kind: "exec" as const,
          request: { command: "echo stale", agentId: "main", sessionKey: "global" },
          createdAtMs: 1,
          expiresAtMs: 10_000,
        },
      ],
      connectionEpoch: 1,
      sessions: {
        subscribeMessages,
        unsubscribeMessages: vi.fn(async () => undefined),
      },
      requestUpdate: vi.fn(),
    };

    const sync = syncSelectedSessionMessageSubscription(state as never);
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
});
