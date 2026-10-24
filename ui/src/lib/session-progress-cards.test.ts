import type { ProgressCard, ProgressCardGetParams } from "@openclaw/gateway-protocol";
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
import {
  createGateway,
  createProgressCard,
  sessionKey,
} from "./session-progress-cards.test-support.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

const target = { sessionKey };
const progress = (fields: Partial<ProgressCard> = {}): ProgressCard => ({
  ...createProgressCard(1),
  ...fields,
});
const accepted = { runId: "refresh-run", status: "accepted" as const, revision: 1 };
const completedCard = () => ({
  ...createProgressCard(1),
  steps: [{ step: "Done", status: "completed" as const }],
});
const deniedError = () =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "Participation required",
    details: { code: "SESSION_PARTICIPATION_REQUIRED" },
  });

function watchCards(gateway: ApplicationGateway, targets: ProgressCardGetParams[] = [target]) {
  const store = sessionProgressCardsForGateway(gateway);
  const owner = {};
  store.watch(owner, targets);
  onTestFinished(() => {
    store.unwatch(owner);
    vi.useRealTimers();
  });
  return { store, owner };
}

function refreshFixture(reply: typeof accepted | Promise<typeof accepted> = accepted) {
  const gateway = createGateway();
  const state = { card: createProgressCard(1) };
  const respond = (result: typeof reply = accepted) =>
    gateway.request.mockImplementation(async (method) =>
      method === "progressCard.refresh" ? result : { card: state.card },
    );
  respond(reply);
  const { store, owner } = watchCards(gateway.gateway);
  return {
    ...gateway,
    store,
    owner,
    state,
    respond,
    calls: (method: string) =>
      gateway.request.mock.calls.filter(([name]) => name === `progressCard.${method}`),
    async publish() {
      state.card = { ...state.card, revision: 2, updatedAt: 2, markdown: "Updated progress" };
      gateway.emitChange(sessionKey, 2);
      await store.load(target);
    },
  };
}

async function loadedFixture(card: ProgressCard = completedCard()) {
  const h = createGateway();
  h.request.mockResolvedValueOnce({ card });
  const watched = watchCards(h.gateway);
  await watched.store.load(target);
  return { ...h, ...watched, card };
}

describe("session progress card lifetimes", () => {
  it.each(["updated", "absent"] as const)(
    "hydrates before hello, then accepts %s",
    async (outcome) => {
      const { gateway, request, snapshotChanged, emit, emitChange } = createGateway();
      gateway.snapshot.phase = "connecting";
      const { store, owner } = watchCards(gateway);
      const cached = createProgressCard(10);
      store.hydrate(target, cached);
      const lifetime = store.getLifetime(target);
      expect(store.get(target)).toEqual(cached);
      expect(request).not.toHaveBeenCalled();
      const live = outcome === "updated" ? progress({ revision: 2, markdown: "Finished" }) : null;
      const response = createDeferred<{ card: typeof live }>();
      request.mockReturnValue(response.promise);
      gateway.snapshot.phase = "connected";
      snapshotChanged();
      expect(store.get(target)).toEqual(cached);
      response.resolve({ card: live });
      await store.load(target);
      expect(store.get(target)).toEqual(live);
      expect(store.getLifetime(target)).toBe(live ? lifetime : undefined);
      store.hydrate(target, cached);
      expect(store.get(target)).toEqual(live);
      const currentLifetime = store.getLifetime(target);
      emit(createGatewayEvent("sessions.changed", { key: sessionKey, reason: "patch" }));
      expect(store.getLifetime(target)).toBe(currentLifetime);
      store.unwatch(owner);
      store.watch(owner, [target]);
      await store.load(target);
      expect(store.getLifetime(target)).toBe(currentLifetime);
      if (!live) {
        const revived = progress({ revision: 3 });
        request.mockResolvedValueOnce({ card: revived });
        emitChange(sessionKey, 3);
        await expect(store.load(target)).resolves.toEqual(revived);
        expect(store.getLifetime(target)).toBeDefined();
        expect(store.getLifetime(target)).not.toBe(lifetime);
      }
    },
  );

  it("retires cached progress when the authenticated presentation scope changes", () => {
    const { gateway, snapshotChanged } = createGateway();
    gateway.snapshot.phase = "connecting";
    const { store } = watchCards(gateway);
    store.hydrate(target, createProgressCard(10));
    expect(store.get(target)).not.toBeNull();
    Object.defineProperty(gateway, "connectionRevision", { value: 1 });
    snapshotChanged();
    expect(store.get(target)).toBeUndefined();
    expect(store.getLifetime(target)).toBeUndefined();
  });
});

describe("session progress card read recovery", () => {
  it("publishes admitted read completion without starting another request", async () => {
    const { gateway, request } = createGateway();
    const response = createDeferred<{ card: null }>();
    request.mockReturnValue(response.promise);
    const store = sessionProgressCardsForGateway(gateway);
    const observed: Array<Promise<unknown> | undefined> = [];
    const stop = store.subscribe(() => observed.push(store.getReadCompletion(target)));
    onTestFinished(stop);
    watchCards(gateway);
    const completion = store.getReadCompletion(target);
    expect(completion).toBeDefined();
    expect(observed).toContain(completion);
    response.resolve({ card: null });
    await expect(completion).resolves.toBeNull();
    expect(store.getReadCompletion(target)).toBeUndefined();
    expect(observed.at(-1)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["initial", "empty", "card"] as const)(
    "recovers a failed read from %s",
    async (state) => {
      vi.useFakeTimers();
      const { gateway, request, emitChange } = createGateway();
      const card = progress();
      const failure = new Error("Temporary read failure");
      const cached = state === "initial" ? undefined : state === "empty" ? null : card;
      if (cached === undefined) {
        request.mockRejectedValueOnce(failure);
      } else {
        request.mockResolvedValueOnce({ card: cached });
      }
      const { store } = watchCards(gateway);
      if (cached !== undefined) {
        await store.load(target);
        request.mockRejectedValueOnce(failure);
        emitChange(sessionKey, 2);
      }
      await expect(store.load(target)).rejects.toBe(failure);
      expect(store.get(target)).toEqual(cached);
      const count = request.mock.calls.length;
      const recovered = progress({ revision: 2, markdown: "Recovered progress" });
      request.mockResolvedValue({ card: recovered });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(request).toHaveBeenCalledTimes(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.get(target)).toEqual(recovered);
      expect(store.getError(target)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(count + 1);
      expect(request.mock.calls.every(([method]) => method === "progressCard.get")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["hidden", "unwatched", "offline", "denied"] as const)(
    "retires read recovery when %s",
    async (boundary) => {
      vi.useFakeTimers();
      const { gateway, request, snapshotChanged } = createGateway();
      const failure = new Error("Temporary read failure");
      request.mockRejectedValue(failure);
      const { store, owner } = watchCards(gateway);
      await expect(store.load(target)).rejects.toBe(failure);
      if (boundary === "hidden") {
        store.watch(owner, [target], { admitAutomaticRead: () => false });
      } else if (boundary === "unwatched") {
        store.unwatch(owner);
      } else if (boundary === "offline") {
        gateway.snapshot.phase = "reconnecting";
        snapshotChanged();
      } else {
        const denied = deniedError();
        request.mockRejectedValueOnce(denied);
        await expect(store.load(target)).rejects.toBe(denied);
        expect(store.get(target)).toBeNull();
        expect(store.getError(target)).toBe("access-denied");
      }
      const count = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe("session progress card refresh", () => {
  it.each([
    { outcome: "accepted", eventFirst: false },
    { outcome: "accepted", eventFirst: true },
    { outcome: "retry", eventFirst: false },
    { outcome: "retry", eventFirst: true },
    { outcome: "timeout", eventFirst: false },
    { outcome: "terminal", eventFirst: false },
  ])(
    "confirms authoritative progress after $outcome (event first: $eventFirst)",
    async ({ outcome, eventFirst }) => {
      vi.useFakeTimers();
      const acceptance = createDeferred<typeof accepted>();
      const f = refreshFixture(acceptance.promise);
      const original = (await f.store.load(target))!;
      f.store.refresh(target, original);
      f.store.refresh(target, original);
      expect(f.calls("refresh")).toHaveLength(1);
      expect(f.store.get(target)).toBe(original);
      f.emitChange(sessionKey, 1);
      await f.store.load(target);
      expect(f.store.getRefreshState(target)).toBe("pending");
      if (eventFirst) {
        await f.publish();
        expect(f.store.getRefreshState(target)).toBe("pending");
      }
      if (outcome === "retry" || outcome === "terminal") {
        acceptance.reject(
          outcome === "terminal"
            ? new GatewayRequestError({
                code: "UNAVAILABLE",
                message: "Refresh completed without updating the card",
                details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" },
              })
            : new Error("Admission reply unavailable"),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(f.store.getRefreshState(target)).toBe("failed");
        expect(f.store.get(target)).toEqual(eventFirst ? f.state.card : original);
        expect(f.store.getError(target)).toBeUndefined();
        f.respond();
        f.store.refresh(target, f.store.get(target)!);
        f.store.refresh(target, f.store.get(target)!);
        const calls = f.calls("refresh");
        expect(calls).toHaveLength(2);
        if (outcome === "terminal") {
          expect(calls[1]?.[1].idempotencyKey).not.toBe(calls[0]?.[1].idempotencyKey);
        } else {
          expect(calls[1]).toEqual(calls[0]);
        }
      } else {
        acceptance.resolve(accepted);
      }
      await vi.advanceTimersByTimeAsync(0);
      if (!eventFirst) {
        expect(f.store.getRefreshState(target)).toBe("pending");
        if (outcome === "timeout") {
          await vi.advanceTimersByTimeAsync(120_000);
          expect(f.store.getRefreshState(target)).toBe("timeout");
          expect(f.store.get(target)).toBe(original);
          expect(f.calls("get")).toHaveLength(1);
        }
        await f.publish();
      }
      expect(f.store.getRefreshState(target)).toBe("updated");
      expect(f.store.get(target)).toEqual(f.state.card);
    },
  );

  it.each(["failed read", "missed event"])(
    "retries an authoritative read after a %s without duplicating refresh intent",
    async (missedUpdate) => {
      vi.useFakeTimers();
      const f = refreshFixture();
      const original = (await f.store.load(target))!;
      f.store.refresh(target, original);
      f.state.card = { ...f.state.card, revision: 2, updatedAt: 2, markdown: "Saved new progress" };
      if (missedUpdate === "failed read") {
        const failure = new Error("Changed-event read unavailable");
        f.request.mockRejectedValueOnce(failure);
        f.emitChange(sessionKey, 2);
        await expect(f.store.load(target)).rejects.toBe(failure);
        expect(f.store.getError(target)).toBe("unavailable");
        f.request.mockImplementation(async (method) => {
          if (method === "progressCard.get") {
            throw failure;
          }
          return accepted;
        });
      }
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.store.getRefreshState(target)).toBe("timeout");
      expect(f.store.get(target)).toBe(original);
      const retryRead = createDeferred<{ card: typeof original }>();
      f.request.mockImplementation(async (method) =>
        method === "progressCard.refresh" ? accepted : retryRead.promise,
      );
      const reads = f.calls("get").length;
      f.store.refresh(target, original);
      f.store.refresh(target, original);
      expect(f.calls("refresh")).toEqual([f.calls("refresh")[0], f.calls("refresh")[0]]);
      expect(f.calls("get")).toHaveLength(reads + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.getRefreshState(target)).toBe("pending");
      retryRead.reject(new Error("Retry read unavailable"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.get(target)).toBe(original);
      expect(f.store.getError(target)).toBe("unavailable");
      f.respond();
      await f.store.load(target);
      expect(f.store.get(target)).toEqual(f.state.card);
      expect(f.store.getRefreshState(target)).toBe("updated");
      expect(f.store.getError(target)).toBeUndefined();
    },
  );

  it.each(["replace", "reset", "detach"])(
    "retires stale retry reads and acceptance after %s",
    async (transition) => {
      vi.useFakeTimers();
      const f = refreshFixture();
      const acceptance = createDeferred<typeof accepted>();
      const retryRead = createDeferred<{ card: typeof f.state.card }>();
      f.store.refresh(target, (await f.store.load(target))!);
      await vi.advanceTimersByTimeAsync(120_000);
      f.request.mockReturnValueOnce(acceptance.promise).mockReturnValueOnce(retryRead.promise);
      f.store.refresh(target, f.store.get(target)!);
      const interruptedRead = f.store.load(target);
      if (transition === "reset") {
        f.emit(
          createGatewayEvent("sessions.changed", { key: sessionKey, sessionKey, reason: "reset" }),
        );
      } else if (transition === "detach") {
        f.store.unwatch(f.owner);
        f.store.watch(f.owner, [target]);
      } else {
        f.gateway.snapshot.client = createTestGatewayClient(f.request);
        f.snapshotChanged();
      }
      await f.store.load(target);
      acceptance.resolve(accepted);
      retryRead.resolve({ card: { ...f.state.card, revision: 2, markdown: "Retired progress" } });
      await expect(interruptedRead).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.get(target)).toEqual(f.state.card);
      await f.publish();
      expect(f.store.getRefreshState(target)).toBeUndefined();
    },
  );
});

describe("session progress card Gateway response boundary", () => {
  it.each([
    { method: "get", denied: true },
    { method: "get", denied: false },
    { method: "put", denied: true },
    { method: "put", denied: false },
    { method: "get", denied: true, forbidden: true },
    { method: "put", denied: false, forbidden: true },
  ])(
    "revalidates $method errors (denied: $denied, forbidden: $forbidden)",
    async ({ method, denied, forbidden }) => {
      const { gateway, request, emitChange, features } = createGateway();
      features.methods = [];
      const sibling = { sessionKey: "agent:main:other-progress" };
      const card = completedCard();
      const siblingCard = progress({ sessionKey: sibling.sessionKey, markdown: "Other session" });
      request.mockImplementation(async (_method, params) => ({
        card: params.sessionKey === sessionKey ? card : siblingCard,
      }));
      const { store } = watchCards(gateway, [target, sibling]);
      await Promise.all([store.load(target), store.load(sibling)]);
      const lifetime = store.getLifetime(target);
      const error = forbidden
        ? new GatewayRequestError({ code: "FORBIDDEN", message: "Forbidden" })
        : denied
          ? deniedError()
          : new Error("Temporary connection failure");
      request.mockRejectedValueOnce(error);
      if (method === "get") {
        emitChange(sessionKey, 2);
        await expect(store.load(target)).rejects.toBe(error);
      } else {
        await expect(store.dismiss(target, card)).rejects.toBe(error);
      }
      expect(store.get(target)).toEqual(denied ? null : card);
      expect(store.getLifetime(target)).toBe(lifetime);
      expect(store.getError(target)).toBe(denied ? "access-denied" : "unavailable");
      expect(store.get(sibling)).toEqual(siblingCard);
      const restored = progress({ revision: 2, markdown: "Refreshed progress" });
      request.mockResolvedValueOnce({ card: restored });
      await expect(store.load(target)).resolves.toEqual(restored);
      expect(store.getError(target)).toBeUndefined();
      expect(store.getLifetime(target)).toBe(lifetime);
    },
  );

  it.each([
    { replacement: false, eventFirst: true, failure: false },
    { replacement: true, eventFirst: true, failure: false },
    { replacement: true, eventFirst: false, failure: false },
    { replacement: false, eventFirst: false, failure: true },
  ])(
    "settles clear without losing newer progress ($replacement, $eventFirst, $failure)",
    async ({ replacement, eventFirst, failure }) => {
      const { store, request, emitChange, card } = await loadedFixture();
      const next = replacement ? progress({ revision: 3, markdown: "New progress" }) : null;
      const put = createDeferred<{ card: null }>();
      const read = createDeferred<{ card: typeof next }>();
      request.mockImplementation((method) =>
        method === "progressCard.put" ? put.promise : read.promise,
      );
      onTestFinished(() => {
        put.resolve({ card: null });
        read.resolve({ card: next });
      });
      const dismissal = store.dismiss(target, card);
      emitChange(sessionKey, null);
      const refreshing = store.load(target);
      if (eventFirst) {
        read.resolve({ card: next });
        await refreshing;
        expect(store.get(target)).toEqual(next);
      }
      put.resolve({ card: null });
      await expect(dismissal).resolves.toBe(true);
      if (failure) {
        const error = new Error("Refresh temporarily unavailable");
        const rejected = expect(refreshing).rejects.toBe(error);
        read.reject(error);
        await rejected;
      } else {
        read.resolve({ card: next });
        await expect(refreshing).resolves.toEqual(next);
      }
      expect(store.get(target)).toEqual(next);
    },
  );

  it("retires a transient error when a conditional clear returns newer progress", async () => {
    const { store, request, card } = await loadedFixture();
    const replacement = progress({ revision: 2, markdown: "New progress" });
    const failure = new Error("Put temporarily unavailable");
    request.mockRejectedValueOnce(failure).mockResolvedValueOnce({ card: replacement });
    await expect(store.dismiss(target, card)).rejects.toBe(failure);
    expect(store.getError(target)).toBe("unavailable");
    await expect(store.dismiss(target, card)).resolves.toBe(false);
    expect(store.get(target)).toEqual(replacement);
    expect(store.getError(target)).toBeUndefined();
    await expect(store.load(target)).resolves.toEqual(replacement);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps a retained global row distinct from an ordinary row with the same wire key", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const global = { sessionKey: "global" };
    const ordinary = { sessionKey: "agent:main:global" };
    const globalCard = progress({ sessionKey: ordinary.sessionKey, markdown: "Global" });
    const ordinaryCard = { ...globalCard, markdown: "Ordinary" };
    request.mockImplementation(async (method, params) => ({
      card:
        method === "progressCard.put"
          ? null
          : params.sessionKey === "global"
            ? globalCard
            : ordinaryCard,
    }));
    const { store } = watchCards(gateway, [ordinary]);
    await expect(store.load(global)).resolves.toEqual(globalCard);
    await expect(store.load(ordinary)).resolves.toEqual(ordinaryCard);
    expect(store.get(global)).toEqual(globalCard);
    expect(store.get(ordinary)).toEqual(ordinaryCard);
    expect(store.getLifetime(global)).not.toBe(store.getLifetime(ordinary));
    const ordinaryLifetime = store.getLifetime(ordinary);
    request.mockClear();
    emitChange(ordinary.sessionKey, null);
    await store.load(ordinary);
    expect(store.get(ordinary)).toEqual(ordinaryCard);
    expect(store.getLifetime(ordinary)).toBe(ordinaryLifetime);
    expect(request).toHaveBeenCalledExactlyOnceWith("progressCard.get", ordinary);
    request.mockClear();
    await expect(store.dismiss(ordinary, globalCard)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(store.get(ordinary)).toEqual(ordinaryCard);
  });

  it.each([
    ["agent:main:main", "main", "notes", "agent:research:notes", "agent:main:notes", "notes"],
    ["agent:main:main", "main", "unknown", "unknown", "unknown", "unknown"],
    ["global", "main", "global", "global", "global", "global"],
    ["global", "conversation", "agent:research:conversation", "global", "global", "global"],
    [
      "agent:main:main",
      "main",
      "agent:research:global",
      "agent:research:global",
      "agent:main:global",
      "global",
    ],
  ])(
    "routes %s / %s / %s by owner",
    async (mainSessionKey, mainKey, input, query, mainQuery, tail) => {
      const { gateway, request, emitChange } = createGateway(mainSessionKey, mainKey);
      const research = { sessionKey: input, agentId: "Research" };
      const canonical = { sessionKey: query, agentId: "research" };
      const main = { sessionKey: tail === "notes" ? "notes" : mainQuery, agentId: "main" };
      const requestTarget = {
        sessionKey: query,
        ...(!query.startsWith("agent:") ? { agentId: "research" } : {}),
      };
      const card = progress({ sessionKey: `agent:research:${tail}` });
      const mainCard = progress({ sessionKey: `agent:main:${tail}`, markdown: "Main" });
      request.mockResolvedValueOnce({ card }).mockResolvedValueOnce({ card: mainCard });
      const { store } = watchCards(gateway, [research, main]);
      await expect(store.load(research)).resolves.toEqual(card);
      await expect(store.load(main)).resolves.toEqual(mainCard);
      expect(request).toHaveBeenCalledWith("progressCard.get", requestTarget);
      expect(request).toHaveBeenCalledWith("progressCard.get", {
        sessionKey: mainQuery,
        ...(!mainQuery.startsWith("agent:") ? { agentId: "main" } : {}),
      });
      expect(store.get(canonical)).toEqual(card);
      if (tail === "notes") {
        expect(store.get({ sessionKey: mainQuery, agentId: "research" })).toBe(store.get(main));
      }
      request.mockResolvedValueOnce(accepted);
      store.refresh(research, card);
      expect(request).toHaveBeenLastCalledWith("progressCard.refresh", {
        ...requestTarget,
        idempotencyKey: expect.any(String),
      });
      const completed = { ...card, revision: 2, steps: completedCard().steps };
      request.mockResolvedValueOnce({ card: completed });
      emitChange(card.sessionKey, tail === "notes" ? null : 2);
      await store.load(research);
      expect(store.get(canonical)).toEqual(completed);
      expect(store.getRefreshState(research)).toBe("updated");
      expect(store.getRefreshState(main)).toBeUndefined();
      expect(request).toHaveBeenLastCalledWith("progressCard.get", requestTarget);
      request.mockResolvedValueOnce({ card: null });
      await expect(store.dismiss(research, completed)).resolves.toBe(true);
      expect(request).toHaveBeenLastCalledWith("progressCard.put", {
        ...requestTarget,
        expectedRevision: 2,
      });
      expect(store.get(canonical)).toBeNull();
      expect(store.get(research)).toBeNull();
      expect(store.get(main)).toEqual(mainCard);
    },
  );

  it.each([
    { transition: "replace", reject: false },
    { transition: "replace", reject: true },
    { transition: "reconnect", reject: false },
    { transition: "reconnect", reject: true },
  ])("retires stale reads across $transition (reject: $reject)", async ({ transition, reject }) => {
    stubGatewayStoreTestGlobals();
    const { gateway, current } = createGatewayStoreTestStore();
    const alias = "agent:research:main";
    const reconnectTarget = { sessionKey: alias, agentId: "research" };
    const replacing = transition === "replace";
    const oldCard = progress({ sessionKey: replacing ? "agent:research:global" : alias });
    const fresh = { ...oldCard, sessionKey: alias, revision: 2, markdown: "Fresh progress" };
    const hello = (mainSessionKey: string) => ({
      ...GATEWAY_STORE_TEST_HELLO,
      features: { methods: ["progressCard.get"] },
      snapshot: { sessionDefaults: { mainSessionKey, mainKey: "main", defaultAgentId: "main" } },
    });
    gateway.start();
    current().request.mockResolvedValue({ card: oldCard });
    current().testOptions.onHello?.(hello(replacing ? "global" : "agent:main:main"));
    const { store } = watchCards(gateway, [reconnectTarget]);
    onTestFinished(() => {
      gateway.stop();
      setAvatarGatewayOrigin(null);
      vi.unstubAllGlobals();
    });
    await store.load(reconnectTarget);
    expect(store.get(reconnectTarget)).toEqual(oldCard);
    const lifetime = store.getLifetime(reconnectTarget);
    const oldClient = current();
    const reply = createDeferred<{ card: ProgressCard }>();
    oldClient.request.mockReturnValueOnce(reply.promise);
    const changed = (revision: number) =>
      oldClient.testOptions.onEvent?.(
        createGatewayEvent("progressCard.changed", { sessionKey: oldCard.sessionKey, revision }),
      );
    changed(2);
    const interrupted = store.load(reconnectTarget);
    changed(3);
    if (replacing) {
      gateway.connect();
    } else {
      oldClient.testOptions.onClose?.({ code: 1006, reason: "socket lost", willRetry: true });
      expect(gateway.snapshot.phase).toBe("reconnecting");
      expect(gateway.snapshot.client).toBe(oldClient);
      expect(store.get(reconnectTarget)).toEqual(oldCard);
    }
    const active = current();
    active.request.mockResolvedValue({ card: fresh });
    active.testOptions.onHello?.(hello("agent:main:main"));
    await vi.waitFor(() => expect(store.get(reconnectTarget)).toEqual(fresh));
    const activeLifetime = store.getLifetime(reconnectTarget);
    expect(activeLifetime).toBeDefined();
    if (!replacing) {
      expect(activeLifetime).toBe(lifetime);
    }
    if (reject) {
      const error = new Error("Retired connection read failed");
      reply.reject(error);
      await expect(interrupted).rejects.toBe(error);
    } else {
      reply.resolve({ card: oldCard });
      await expect(interrupted).resolves.toBeNull();
    }
    expect(store.getError(reconnectTarget)).toBeUndefined();
    expect(store.get(reconnectTarget)).toEqual(fresh);
    expect(store.getLifetime(reconnectTarget)).toBe(activeLifetime);
    expect(active.request).toHaveBeenCalledTimes(replacing ? 1 : 3);
  });

  it.each([
    { method: "get", updatedAt: -MAX_DATE_TIMESTAMP_MS, valid: true },
    { method: "get", updatedAt: -MAX_DATE_TIMESTAMP_MS - 1, valid: false },
    { method: "put", updatedAt: -MAX_DATE_TIMESTAMP_MS - 1, valid: false },
    { method: "get", updatedAt: MAX_DATE_TIMESTAMP_MS, valid: true },
    { method: "get", updatedAt: MAX_DATE_TIMESTAMP_MS + 1, valid: false },
    { method: "put", updatedAt: MAX_DATE_TIMESTAMP_MS + 1, valid: false },
  ])(
    "validates progressCard.$method timestamp $updatedAt",
    async ({ method, updatedAt, valid }) => {
      const { gateway, request } = createGateway();
      const store = sessionProgressCardsForGateway(gateway);
      const existingCard = createProgressCard(1);
      if (method === "put") {
        request.mockResolvedValueOnce({ card: existingCard });
      }
      request.mockResolvedValueOnce({ card: createProgressCard(updatedAt) });
      const result =
        method === "put" ? store.dismiss(target, (await store.load(target))!) : store.load(target);
      if (valid) {
        await expect(result).resolves.toMatchObject({ updatedAt });
        expect(store.get(target)?.updatedAt).toBe(updatedAt);
      } else {
        await expect(result).rejects.toThrow(
          "Progress card response did not match the requested session",
        );
        if (method === "put") {
          expect(store.get(target)?.updatedAt).toBe(existingCard.updatedAt);
        } else {
          expect(store.get(target)).toBeUndefined();
          expect(store.getError(target)).toBe("unavailable");
        }
      }
    },
  );
});
