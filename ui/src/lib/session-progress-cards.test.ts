import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { setAvatarGatewayOrigin } from "./identity-avatar-context.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

const sessionKey = "agent:main:progress-date-boundary";

function createProgressCard(updatedAt: number) {
  return { sessionKey, revision: 1, updatedAt, markdown: "Progress update" };
}

function createGateway(mainSessionKey?: string, mainKey = "main") {
  const request = vi.fn();
  const features = {
    methods: ["progressCard.get", "progressCard.put"],
  };
  let onEvent: Parameters<ApplicationGateway["subscribeEvents"]>[0] | undefined;
  let onSnapshot: Parameters<ApplicationGateway["subscribe"]>[0] | undefined;
  const gateway = {
    snapshot: {
      client: { request },
      phase: "connected",
      hello: {
        features,
        snapshot: { sessionDefaults: { mainSessionKey, mainKey, defaultAgentId: "main" } },
      },
    },
    subscribe: (listener: NonNullable<typeof onSnapshot>) => {
      onSnapshot = listener;
      return () => {
        onSnapshot = undefined;
      };
    },
    subscribeEvents: (listener: NonNullable<typeof onEvent>) => {
      onEvent = listener;
      return () => {
        onEvent = undefined;
      };
    },
  } as unknown as ApplicationGateway;
  return {
    gateway,
    request,
    features,
    snapshotChanged: () => onSnapshot?.(gateway.snapshot),
    emit: (event: Parameters<NonNullable<typeof onEvent>>[0]) => onEvent?.(event),
    emitChange: (changedSessionKey: string, revision: number | null) =>
      onEvent?.({
        type: "event",
        event: "progressCard.changed",
        payload: { sessionKey: changedSessionKey, revision },
      }),
  };
}

describe("session progress card lifetimes", () => {
  it("ends a lifetime only after an accepted clear, not revisions, errors, or idle detach", async () => {
    const { gateway, request, emitChange, emit } = createGateway();
    const target = { sessionKey };
    const owner = {};
    const card = createProgressCard(1);
    request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(gateway);
    store.watch(owner, [target]);
    onTestFinished(() => store.unwatch(owner));
    await store.load(target);
    const lifetime = store.getLifetime(target);
    expect(lifetime).toBeDefined();
    emit(createGatewayEvent("sessions.changed", { key: sessionKey, reason: "patch" }));
    expect(store.getLifetime(target)).toBe(lifetime);

    request.mockResolvedValue({ card: { ...card, revision: 2 } });
    emitChange(sessionKey, 2);
    await store.load(target);
    expect(store.getLifetime(target)).toBe(lifetime);
    request.mockRejectedValueOnce(new Error("temporary failure"));
    emitChange(sessionKey, 3);
    await expect(store.load(target)).rejects.toThrow("temporary failure");
    expect(store.getLifetime(target)).toBe(lifetime);
    request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "denied",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      }),
    );
    await expect(store.load(target)).rejects.toThrow("denied");
    expect(store.get(target)).toBeNull();
    expect(store.getLifetime(target)).toBe(lifetime);
    await store.load(target);
    expect(store.getLifetime(target)).toBe(lifetime);

    store.unwatch(owner);
    store.watch(owner, [target]);
    await store.load(target);
    expect(store.getLifetime(target)).toBe(lifetime);
    request.mockResolvedValueOnce({ card: null });
    emitChange(sessionKey, null);
    await store.load(target);
    expect(store.getLifetime(target)).toBeUndefined();
    emitChange(sessionKey, 5);
    await store.load(target);
    expect(store.getLifetime(target)).toBeDefined();
    expect(store.getLifetime(target)).not.toBe(lifetime);
  });
});

describe("session progress card refresh", () => {
  it.each([false, true])(
    "waits for a higher authoritative revision (event first: %s)",
    async (eventFirst) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      let card = createProgressCard(1);
      const acceptance = createDeferred<{ runId: string; status: "accepted"; revision: number }>();
      request.mockImplementation(async (method) =>
        method === "progressCard.refresh" ? acceptance.promise : { card },
      );
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => store.unwatch(owner));
      const original = (await store.load(target))!;
      store.refresh(target, original);
      store.refresh(target, original);
      expect(request.mock.calls.filter(([method]) => method === "progressCard.refresh")).toEqual([
        ["progressCard.refresh", { sessionKey, idempotencyKey: expect.any(String) }],
      ]);
      expect(store.get(target)).toBe(original);
      expect(store.getRefreshState(target)).toBe("pending");
      emitChange(sessionKey, 1);
      await store.load(target);
      expect(store.getRefreshState(target)).toBe("pending");
      if (!eventFirst) {
        acceptance.resolve({ runId: "refresh-run", status: "accepted", revision: 1 });
        await acceptance.promise;
        await Promise.resolve();
        expect(store.getRefreshState(target)).toBe("pending");
      }
      card = { ...card, revision: 2, updatedAt: 2, markdown: "Confirmed new progress" };
      emitChange(sessionKey, 2);
      await store.load(target);
      if (eventFirst) {
        expect(store.getRefreshState(target)).toBe("pending");
        acceptance.resolve({ runId: "refresh-run", status: "accepted", revision: 1 });
      }
      await vi.waitFor(() => expect(store.getRefreshState(target)).toBe("updated"));
      expect(store.get(target)).toEqual(card);
      expect(request.mock.calls.every(([method]) => method.startsWith("progressCard."))).toBe(true);
    },
  );

  it("keeps prior content on failure, coalesces pending calls, and retries the same intent", async () => {
    const { gateway, request, emitChange } = createGateway();
    const target = { sessionKey };
    let card = createProgressCard(1);
    let fail = true;
    request.mockImplementation(async (method) => {
      if (method === "progressCard.refresh") {
        if (fail) {
          throw new Error("Admission unavailable");
        }
        return { runId: "retry-run", status: "accepted", revision: 1 };
      }
      return { card };
    });
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => store.unwatch(owner));
    const original = (await store.load(target))!;
    store.refresh(target, original);
    await vi.waitFor(() => expect(store.getRefreshState(target)).toBe("failed"));
    expect(store.get(target)).toBe(original);
    expect(store.getError(target)).toBeUndefined();
    fail = false;
    store.refresh(target, original);
    store.refresh(target, original);
    const calls = request.mock.calls.filter(([method]) => method === "progressCard.refresh");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    await Promise.resolve();
    card = { ...card, revision: 2, updatedAt: 2 };
    emitChange(sessionKey, 2);
    await store.load(target);
    expect(store.getRefreshState(target)).toBe("updated");
  });

  it("starts a new intent only after the Gateway confirms completion without an update", async () => {
    vi.useFakeTimers();
    const { gateway, request, emitChange } = createGateway();
    const target = { sessionKey };
    let card = createProgressCard(1);
    request.mockImplementation(async (method) =>
      method === "progressCard.refresh"
        ? { runId: "refresh-run", status: "accepted", revision: 1 }
        : { card },
    );
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => {
      store.unwatch(owner);
      vi.useRealTimers();
    });
    store.refresh(target, (await store.load(target))!);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.getRefreshState(target)).toBe("timeout");
    request.mockRejectedValueOnce(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Refresh completed without updating the card",
        details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" },
      }),
    );
    store.refresh(target, store.get(target)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRefreshState(target)).toBe("failed");
    expect(store.get(target)).toEqual(card);
    store.refresh(target, store.get(target)!);
    const calls = request.mock.calls.filter(([method]) => method === "progressCard.refresh");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]?.[1].idempotencyKey).not.toBe(calls[0]?.[1].idempotencyKey);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getRefreshState(target)).toBe("pending");
    card = { ...card, revision: 2, updatedAt: 2 };
    emitChange(sessionKey, 2);
    await store.load(target);
    expect(store.getRefreshState(target)).toBe("updated");
  });

  it.each(["failed read", "missed event"])(
    "retries an authoritative read after a %s without duplicating refresh intent",
    async (missedUpdate) => {
      vi.useFakeTimers();
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      let card = createProgressCard(1);
      const acceptance = { runId: "refresh-run", status: "accepted", revision: 1 };
      request.mockImplementation(async (method) =>
        method === "progressCard.refresh" ? acceptance : { card },
      );
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => {
        store.unwatch(owner);
        vi.useRealTimers();
      });
      const original = (await store.load(target))!;
      store.refresh(target, original);
      card = { ...card, revision: 2, updatedAt: 2, markdown: "Saved new progress" };
      if (missedUpdate === "failed read") {
        const failure = new Error("Changed-event read unavailable");
        request.mockRejectedValueOnce(failure);
        emitChange(sessionKey, 2);
        await expect(store.load(target)).rejects.toBe(failure);
        expect(store.getError(target)).toBe("unavailable");
      }
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.getRefreshState(target)).toBe("timeout");
      expect(store.get(target)).toBe(original);
      const retryRead = createDeferred<{ card: typeof card }>();
      request.mockImplementation((method) =>
        method === "progressCard.refresh" ? Promise.resolve(acceptance) : retryRead.promise,
      );
      const previousReads = request.mock.calls.filter(([method]) => method === "progressCard.get");
      store.refresh(target, original);
      store.refresh(target, original);
      const calls = request.mock.calls.filter(([method]) => method === "progressCard.refresh");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
      expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(
        previousReads.length + 1,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get(target)).toBe(original);
      expect(store.getRefreshState(target)).toBe("pending");
      retryRead.reject(new Error("Retry read unavailable"));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get(target)).toBe(original);
      expect(store.getError(target)).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.getRefreshState(target)).toBe("timeout");
      request.mockImplementation(async (method) =>
        method === "progressCard.refresh" ? acceptance : { card },
      );
      store.refresh(target, original);
      await vi.advanceTimersByTimeAsync(0);
      const retries = request.mock.calls.filter(([method]) => method === "progressCard.refresh");
      expect(retries).toHaveLength(3);
      expect(retries[2]).toEqual(retries[0]);
      expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(
        previousReads.length + 2,
      );
      expect(store.get(target)).toEqual(card);
      expect(store.getRefreshState(target)).toBe("updated");
      expect(store.getError(target)).toBeUndefined();
    },
  );

  it("confirms a revision that arrived before an uncertain request is retried", async () => {
    const { gateway, request, emitChange } = createGateway();
    const target = { sessionKey };
    let card = createProgressCard(1);
    const acceptance = createDeferred<{ runId: string; status: "accepted"; revision: number }>();
    request.mockImplementation(async (method) =>
      method === "progressCard.refresh" ? acceptance.promise : { card },
    );
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => store.unwatch(owner));
    store.refresh(target, (await store.load(target))!);
    card = { ...card, revision: 2, updatedAt: 2 };
    emitChange(sessionKey, 2);
    await store.load(target);
    acceptance.reject(new Error("Reply lost after acceptance"));
    await vi.waitFor(() => expect(store.getRefreshState(target)).toBe("failed"));
    request.mockResolvedValueOnce({ runId: "original-run", status: "accepted", revision: 1 });
    store.refresh(target, store.get(target)!);
    await vi.waitFor(() => expect(store.getRefreshState(target)).toBe("updated"));
    const calls = request.mock.calls.filter(([method]) => method === "progressCard.refresh");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("bounds waiting without cancelling work and accepts a late confirmed revision", async () => {
    vi.useFakeTimers();
    const { gateway, request, emitChange } = createGateway();
    const target = { sessionKey };
    let card = createProgressCard(1);
    request.mockImplementation(async (method) =>
      method === "progressCard.refresh"
        ? { runId: "slow-run", status: "accepted", revision: 1 }
        : { card },
    );
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => {
      store.unwatch(owner);
      vi.useRealTimers();
    });
    const original = (await store.load(target))!;
    store.refresh(target, original);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.getRefreshState(target)).toBe("timeout");
    expect(store.get(target)).toBe(original);
    card = { ...card, revision: 2, updatedAt: 2 };
    emitChange(sessionKey, 2);
    await store.load(target);
    expect(store.getRefreshState(target)).toBe("updated");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "progressCard.get",
      "progressCard.refresh",
      "progressCard.get",
    ]);
  });

  it.each(["reconnect", "replace", "reset", "detach"])(
    "retires stale retry reads and acceptance after %s",
    async (transition) => {
      vi.useFakeTimers();
      const { gateway, request, emitChange, snapshotChanged, emit } = createGateway();
      const target = { sessionKey };
      let card = createProgressCard(1);
      const acceptance = createDeferred<{ runId: string; status: "accepted"; revision: number }>();
      const retryRead = createDeferred<{ card: typeof card }>();
      request.mockImplementation(async (method) =>
        method === "progressCard.refresh"
          ? { runId: "old-run", status: "accepted", revision: 1 }
          : { card },
      );
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => {
        store.unwatch(owner);
        vi.useRealTimers();
      });
      store.refresh(target, (await store.load(target))!);
      await vi.advanceTimersByTimeAsync(120_000);
      request.mockReturnValueOnce(acceptance.promise).mockReturnValueOnce(retryRead.promise);
      store.refresh(target, store.get(target)!);
      const interruptedRead = store.load(target);
      if (transition === "reset") {
        emit(
          createGatewayEvent("sessions.changed", { key: sessionKey, sessionKey, reason: "reset" }),
        );
      } else if (transition === "detach") {
        store.unwatch(owner);
        store.watch(owner, [target]);
      } else {
        if (transition === "replace") {
          gateway.snapshot.client = createTestGatewayClient(request);
        } else {
          gateway.snapshot.phase = "reconnecting";
          snapshotChanged();
          gateway.snapshot.phase = "connected";
        }
        snapshotChanged();
      }
      await store.load(target);
      acceptance.resolve({ runId: "old-run", status: "accepted", revision: 1 });
      retryRead.resolve({
        card: { ...card, revision: 2, markdown: "Retired connection progress" },
      });
      await expect(interruptedRead).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.get(target)).toEqual(card);
      card = { ...card, revision: 2, updatedAt: 2 };
      emitChange(sessionKey, 2);
      await store.load(target);
      expect(store.getRefreshState(target)).toBeUndefined();
    },
  );

  it("keeps refresh outcomes with their captured session and agent", async () => {
    const { gateway, request, emitChange } = createGateway();
    const main = { sessionKey: "global", agentId: "main" };
    const research = { sessionKey: "global", agentId: "research" };
    let revision = 1;
    request.mockImplementation(async (method, params) =>
      method === "progressCard.refresh"
        ? { runId: "research-run", status: "accepted", revision: 1 }
        : {
            card: {
              ...createProgressCard(1),
              sessionKey: `agent:${params.agentId}:global`,
              revision: params.agentId === "research" ? revision : 1,
            },
          },
    );
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [research, main]);
    onTestFinished(() => store.unwatch(owner));
    const original = (await store.load(research))!;
    await store.load(main);
    store.refresh(research, original);
    expect(request).toHaveBeenLastCalledWith("progressCard.refresh", {
      ...research,
      idempotencyKey: expect.any(String),
    });
    revision = 2;
    emitChange("agent:research:global", 2);
    await Promise.all([store.load(research), store.load(main)]);
    expect(store.getRefreshState(research)).toBe("updated");
    expect(store.getRefreshState(main)).toBeUndefined();
  });
});

describe("session progress card Gateway response boundary", () => {
  it.each([
    { method: "progressCard.get", denied: true },
    { method: "progressCard.get", denied: false },
    { method: "progressCard.put", denied: true },
    { method: "progressCard.put", denied: false },
  ])(
    "revalidates after $method failure while hiding only denied content (denied: $denied)",
    async ({ method, denied }) => {
      const { gateway, request, emitChange, features } = createGateway();
      // Core methods are called directly; a missing advertisement is not a feature gate.
      features.methods = [];
      const target = { sessionKey };
      const sibling = { sessionKey: "agent:main:other-progress" };
      const card = {
        ...createProgressCard(1),
        steps: [{ step: "Done", status: "completed" as const }],
      };
      const siblingCard = { ...card, sessionKey: sibling.sessionKey, markdown: "Other session" };
      request.mockImplementation(async (_method, params) => ({
        card: params.sessionKey === sessionKey ? card : siblingCard,
      }));
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target, sibling]);
      onTestFinished(() => store.unwatch(owner));
      const [displayed] = await Promise.all([store.load(target), store.load(sibling)]);
      if (!displayed) {
        throw new Error("Expected the loaded progress card");
      }
      const error = denied
        ? new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Participation required",
            details: { code: "SESSION_PARTICIPATION_REQUIRED" },
          })
        : new Error("Temporary connection failure");
      request.mockRejectedValueOnce(error);
      if (method === "progressCard.get") {
        emitChange(sessionKey, 2);
        await expect(store.load(target)).rejects.toBe(error);
        expect(store.getError(target)).toBe(denied ? "access-denied" : "unavailable");
      } else {
        await expect(store.dismiss(target, displayed)).rejects.toBe(error);
      }
      expect(store.get(target)).toEqual(denied ? null : card);
      expect(store.get(sibling)).toEqual(siblingCard);
      const restored = { ...card, revision: 2, markdown: "Refreshed progress" };
      request.mockResolvedValueOnce({ card: restored });
      await expect(store.load(target)).resolves.toEqual(restored);
      expect(request).toHaveBeenLastCalledWith("progressCard.get", target);
      expect(store.getError(target)).toBeUndefined();
    },
  );

  it.each([
    { replacement: false, refreshBeforeReply: true, refreshFails: false },
    { replacement: true, refreshBeforeReply: true, refreshFails: false },
    { replacement: true, refreshBeforeReply: false, refreshFails: false },
    { replacement: false, refreshBeforeReply: false, refreshFails: true },
  ])(
    "acknowledges a clear after its change event without losing newer progress ($replacement, $refreshBeforeReply, $refreshFails)",
    async ({ replacement, refreshBeforeReply, refreshFails }) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      const card = {
        ...createProgressCard(1),
        steps: [{ step: "Done", status: "completed" as const }],
      };
      const nextCard = replacement ? { ...card, revision: 3, markdown: "New progress" } : null;
      const put = createDeferred<{ card: null }>();
      const refresh = createDeferred<{ card: typeof nextCard }>();
      request
        .mockResolvedValueOnce({ card })
        .mockImplementation((method) =>
          method === "progressCard.put" ? put.promise : refresh.promise,
        );
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => {
        put.resolve({ card: null });
        refresh.resolve({ card: nextCard });
        store.unwatch(owner);
      });
      const displayed = await store.load(target);
      if (!displayed) {
        throw new Error("Expected the completed progress card");
      }
      const dismissal = store.dismiss(target, displayed);
      // The Gateway publishes its committed clear before sending the put response.
      emitChange(sessionKey, null);
      expect(request).toHaveBeenNthCalledWith(3, "progressCard.get", target);
      const refreshing = store.load(target);
      if (refreshBeforeReply) {
        refresh.resolve({ card: nextCard });
        await vi.waitFor(() => expect(store.get(target)).toEqual(nextCard));
      }
      put.resolve({ card: null });
      await expect(dismissal).resolves.toBe(true);
      if (refreshFails) {
        // The committed PUT replies before its event-triggered GET can fail.
        const failure = new Error("Refresh temporarily unavailable");
        const rejected = expect(refreshing).rejects.toBe(failure);
        refresh.reject(failure);
        await rejected;
        expect(store.get(target)).toBeNull();
      } else {
        refresh.resolve({ card: nextCard });
        await expect(refreshing).resolves.toEqual(nextCard);
        expect(store.get(target)).toEqual(nextCard);
      }
    },
  );

  it("retires a transient error when a conditional clear returns newer progress", async () => {
    const { gateway, request } = createGateway();
    const target = { sessionKey };
    const card = {
      ...createProgressCard(1),
      steps: [{ step: "Done", status: "completed" as const }],
    };
    const replacement = { ...card, revision: 2, markdown: "New progress" };
    const failure = new Error("Put temporarily unavailable");
    request
      .mockResolvedValueOnce({ card })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ card: replacement });
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => store.unwatch(owner));
    const displayed = await store.load(target);
    if (!displayed) {
      throw new Error("Expected the completed progress card");
    }
    await expect(store.dismiss(target, displayed)).rejects.toBe(failure);
    expect(store.getError(target)).toBe("unavailable");
    // A revision mismatch returns the current card without a changed event.
    await expect(store.dismiss(target, displayed)).resolves.toBe(false);
    expect(store.get(target)).toEqual(replacement);
    expect(store.getError(target)).toBeUndefined();
    await expect(store.load(target)).resolves.toEqual(replacement);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retains bare target ownership for reads, events and dismissals", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const research = { sessionKey: "notes", agentId: "research" };
    const main = { sessionKey: "notes", agentId: "main" };
    const researchKey = "agent:research:notes";
    const mainKey = "agent:main:notes";
    const cards = new Map([
      [researchKey, { sessionKey: researchKey, revision: 1, updatedAt: 1, markdown: "Research" }],
      [mainKey, { sessionKey: mainKey, revision: 1, updatedAt: 1, markdown: "Main" }],
    ]);
    request.mockImplementation(async (method, params) => ({
      card: method === "progressCard.put" ? null : cards.get(params.sessionKey),
    }));
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [research, main]);
    try {
      await expect(store.load(research)).resolves.toEqual(cards.get(researchKey));
      await expect(store.load(main)).resolves.toEqual(cards.get(mainKey));
      expect(request.mock.calls).toEqual([
        ["progressCard.get", { sessionKey: researchKey }],
        ["progressCard.get", { sessionKey: mainKey }],
      ]);
      expect(store.get({ sessionKey: mainKey, agentId: "research" })).toBe(store.get(main));
      const replacement = {
        sessionKey: researchKey,
        revision: 2,
        updatedAt: 2,
        markdown: "Updated",
      };
      cards.set(researchKey, replacement);
      emitChange(researchKey, null);
      await vi.waitFor(() => expect(store.get(research)).toEqual(replacement));
      expect(store.get(main)).toEqual(cards.get(mainKey));
      const card = store.get(research);
      if (!card) {
        throw new Error("Expected the refreshed Research card");
      }
      await expect(store.dismiss(research, card)).resolves.toBe(true);
      expect(request).toHaveBeenLastCalledWith("progressCard.put", {
        sessionKey: researchKey,
        expectedRevision: 2,
      });
      expect(store.get(research)).toBeNull();
      expect(store.get(main)).toEqual(cards.get(mainKey));
    } finally {
      store.unwatch(owner);
    }
  });

  it("preserves the owner-scoped unknown sentinel", async () => {
    const { gateway, request } = createGateway("agent:main:main");
    const target = { sessionKey: "unknown", agentId: "research" };
    const card = {
      sessionKey: "agent:research:unknown",
      revision: 1,
      updatedAt: 1,
      markdown: "Unknown",
    };
    request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(gateway);
    await expect(store.load(target)).resolves.toEqual(card);
    expect(request).toHaveBeenCalledExactlyOnceWith("progressCard.get", target);
  });

  it("keeps a retained global row distinct from an ordinary row with the same wire key", async () => {
    const { gateway, request } = createGateway("agent:main:main");
    const globalCard = {
      sessionKey: "agent:main:global",
      revision: 1,
      updatedAt: 1,
      markdown: "Global",
    };
    const ordinaryCard = { ...globalCard, markdown: "Ordinary" };
    request.mockImplementation(async (method, params) => ({
      card:
        method === "progressCard.put"
          ? null
          : params.sessionKey === "global"
            ? globalCard
            : ordinaryCard,
    }));
    const store = sessionProgressCardsForGateway(gateway);
    await expect(store.load({ sessionKey: "global" })).resolves.toEqual(globalCard);
    await expect(store.load({ sessionKey: "agent:main:global" })).resolves.toEqual(ordinaryCard);
    expect(store.get({ sessionKey: "global" })).toEqual(globalCard);
    expect(store.get({ sessionKey: "agent:main:global" })).toEqual(ordinaryCard);
    expect(store.getLifetime({ sessionKey: "global" })).not.toBe(
      store.getLifetime({ sessionKey: "agent:main:global" }),
    );
    const capturedGlobal = store.get({ sessionKey: "global" });
    if (!capturedGlobal) {
      throw new Error("Expected the loaded global card");
    }
    request.mockClear();
    await expect(store.dismiss({ sessionKey: "agent:main:global" }, capturedGlobal)).resolves.toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
    expect(store.get({ sessionKey: "agent:main:global" })).toEqual(ordinaryCard);
  });

  it("refreshes an ordinary row instead of clearing it on an ambiguous null event", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const ordinaryKey = "agent:main:global";
    const card = { sessionKey: ordinaryKey, revision: 1, updatedAt: 1, markdown: "Ordinary" };
    request.mockResolvedValue({ card });
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [{ sessionKey: ordinaryKey }]);
    await store.load({ sessionKey: ordinaryKey });
    const lifetime = store.getLifetime({ sessionKey: ordinaryKey });
    emitChange(ordinaryKey, null);
    await store.load({ sessionKey: ordinaryKey });
    expect(store.get({ sessionKey: ordinaryKey })).toEqual(card);
    expect(store.getLifetime({ sessionKey: ordinaryKey })).toBe(lifetime);
    expect(request).toHaveBeenCalledTimes(2);
    store.unwatch(owner);
  });

  it.each([
    ["global", "main", "global", "global", "global"],
    ["global", "main", "agent:research:main", "global", "global"],
    ["global", "conversation", "global", "global", "global"],
    ["global", "conversation", "agent:research:conversation", "global", "global"],
    [
      "agent:main:main",
      "main",
      "agent:research:global",
      "agent:research:global",
      "agent:main:global",
    ],
  ])(
    "keeps artifact snapshots owner-scoped through reads, events and clear with %s / %s routing and %s input",
    async (mainSessionKey, mainKey, researchInputKey, researchQueryKey, mainQueryKey) => {
      const { gateway, request, emitChange } = createGateway(mainSessionKey, mainKey);
      const researchKey = "agent:research:global";
      const mainKeyRef = "agent:main:global";
      const researchCard = {
        sessionKey: researchKey,
        revision: 1,
        updatedAt: 1,
        markdown: "Research progress",
      };
      const mainCard = {
        sessionKey: mainKeyRef,
        revision: 1,
        updatedAt: 1,
        markdown: "Main progress",
      };
      request
        .mockResolvedValueOnce({ card: researchCard })
        .mockResolvedValueOnce({ card: mainCard });
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      const researchTarget = { sessionKey: researchInputKey, agentId: "research" };
      const canonicalResearch = { sessionKey: researchQueryKey, agentId: "research" };
      const mainTarget = { sessionKey: mainQueryKey, agentId: "main" };
      store.watch(owner, [researchTarget, mainTarget]);
      await Promise.all([store.load(researchTarget), store.load(mainTarget)]);
      expect(request).toHaveBeenNthCalledWith(1, "progressCard.get", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
      });
      expect(request).toHaveBeenNthCalledWith(2, "progressCard.get", {
        sessionKey: mainQueryKey,
        ...(mainQueryKey === "global" ? { agentId: "main" } : {}),
      });
      expect(store.get(canonicalResearch)).toEqual(researchCard);
      expect(store.get(researchTarget)).toEqual(researchCard);
      expect(store.get(mainTarget)).toEqual(mainCard);

      const completedCard = {
        ...researchCard,
        revision: 2,
        steps: [{ step: "Research complete", status: "completed" as const }],
      };
      request.mockResolvedValueOnce({ card: completedCard });
      emitChange(researchKey, 2);
      await vi.waitFor(() => expect(store.get(canonicalResearch)).toEqual(completedCard));
      expect(request).toHaveBeenLastCalledWith("progressCard.get", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
      });
      expect(store.get(mainTarget)).toEqual(mainCard);

      request.mockResolvedValueOnce({ card: null });
      const displayedCard = store.get(researchTarget);
      if (!displayedCard) {
        throw new Error("Expected the displayed research card");
      }
      await expect(store.dismiss(researchTarget, displayedCard)).resolves.toBe(true);
      expect(request).toHaveBeenLastCalledWith("progressCard.put", {
        sessionKey: researchQueryKey,
        ...(researchQueryKey === "global" ? { agentId: "research" } : {}),
        expectedRevision: 2,
      });
      expect(store.get(canonicalResearch)).toBeNull();
      expect(store.get(researchTarget)).toBeNull();
      expect(store.get(mainTarget)).toEqual(mainCard);
      store.unwatch(owner);
    },
  );

  it("refreshes a retained watch through replacement and same-client Gateway reconnects", async () => {
    stubGatewayStoreTestGlobals();
    const { gateway, current } = createGatewayStoreTestStore();
    const alias = "agent:research:main";
    const target = { sessionKey: alias, agentId: "research" };
    const oldCard = {
      sessionKey: "agent:research:global",
      revision: 1,
      updatedAt: 1,
      markdown: "Global progress",
    };
    const nextCard = { ...oldCard, sessionKey: alias, markdown: "Per-sender progress" };
    const hello = (mainSessionKey: string) => ({
      ...GATEWAY_STORE_TEST_HELLO,
      features: {
        methods: ["progressCard.get"],
      },
      snapshot: { sessionDefaults: { mainSessionKey, mainKey: "main", defaultAgentId: "main" } },
    });
    gateway.start();
    current().request.mockResolvedValue({ card: oldCard });
    current().opts.onHello?.(hello("global"));
    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    onTestFinished(() => {
      store.unwatch(owner);
      gateway.stop();
      setAvatarGatewayOrigin(null);
      vi.unstubAllGlobals();
    });
    store.watch(owner, [target]);
    await store.load(target);
    expect(store.get(target)).toEqual(oldCard);

    const staleRead = createDeferred<{ card: typeof oldCard }>();
    current().request.mockReturnValueOnce(staleRead.promise);
    current().opts.onEvent?.(
      createGatewayEvent("progressCard.changed", { sessionKey: oldCard.sessionKey, revision: 2 }),
    );
    const oldRead = store.load(target);
    current().opts.onEvent?.(
      createGatewayEvent("progressCard.changed", { sessionKey: oldCard.sessionKey, revision: 3 }),
    );
    gateway.connect();
    const replacement = current();
    replacement.request.mockResolvedValue({ card: nextCard });
    replacement.opts.onHello?.(hello("agent:main:main"));
    await vi.waitFor(() => expect(store.get(target)).toEqual(nextCard));
    staleRead.resolve({ card: oldCard });
    await expect(oldRead).resolves.toBeNull();
    expect(store.get(target)).toEqual(nextCard);
    const replacementLifetime = store.getLifetime(target);
    expect(replacementLifetime).toBeDefined();
    expect(replacement.request).toHaveBeenCalledTimes(1);

    const staleDismiss = createDeferred<{ card: null }>();
    replacement.request.mockReturnValueOnce(staleDismiss.promise);
    const dismissal = store.dismiss(target, store.get(target)!);
    const interruptedRead = createDeferred<{ card: typeof nextCard }>();
    replacement.request.mockReturnValueOnce(interruptedRead.promise);
    replacement.opts.onEvent?.(
      createGatewayEvent("progressCard.changed", { sessionKey: nextCard.sessionKey, revision: 2 }),
    );
    const reconnectRead = store.load(target);
    replacement.opts.onEvent?.(
      createGatewayEvent("progressCard.changed", { sessionKey: nextCard.sessionKey, revision: 3 }),
    );
    replacement.opts.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
    expect(gateway.snapshot.phase).toBe("reconnecting");
    expect(gateway.snapshot.client).toBe(replacement);
    expect(store.get(target)).toEqual(nextCard);
    const refreshedCard = { ...nextCard, revision: 2, markdown: "Progress while disconnected" };
    replacement.request.mockResolvedValue({ card: refreshedCard });
    replacement.opts.onHello?.(hello("agent:main:main"));
    await vi.waitFor(() => expect(store.get(target)).toEqual(refreshedCard));
    interruptedRead.resolve({ card: nextCard });
    await expect(reconnectRead).resolves.toBeNull();
    staleDismiss.resolve({ card: null });
    await expect(dismissal).resolves.toBe(false);
    expect(store.get(target)).toEqual(refreshedCard);
    expect(store.getLifetime(target)).toBe(replacementLifetime);
    expect(replacement.request).toHaveBeenCalledTimes(4);
  });

  it.each([-MAX_DATE_TIMESTAMP_MS, MAX_DATE_TIMESTAMP_MS])(
    "accepts the inclusive JavaScript Date boundary %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load({ sessionKey })).resolves.toMatchObject({ updatedAt });
      expect(store.get({ sessionKey })?.updatedAt).toBe(updatedAt);
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.get: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      await expect(store.load({ sessionKey })).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get({ sessionKey })).toBeUndefined();
      expect(store.getError({ sessionKey })).toBe("unavailable");
    },
  );

  it.each([-MAX_DATE_TIMESTAMP_MS - 1, MAX_DATE_TIMESTAMP_MS + 1])(
    "rejects an out-of-range timestamp from progressCard.put: %i",
    async (updatedAt) => {
      const { gateway, request } = createGateway();
      const existingCard = createProgressCard(Date.now());
      request
        .mockResolvedValueOnce({ card: existingCard })
        .mockResolvedValueOnce({ card: createProgressCard(updatedAt) });

      const store = sessionProgressCardsForGateway(gateway);
      const displayedCard = await store.load({ sessionKey });
      if (!displayedCard) {
        throw new Error("Expected the displayed progress card");
      }
      await expect(store.dismiss({ sessionKey }, displayedCard)).rejects.toThrow(
        "Progress card response did not match the requested session",
      );
      expect(store.get({ sessionKey })?.updatedAt).toBe(existingCard.updatedAt);
    },
  );
});
