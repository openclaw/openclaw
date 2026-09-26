import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGateway,
  createProgressCard,
  sessionKey,
} from "./session-progress-cards.test-support.ts";
import { sessionProgressCardsForGateway } from "./session-progress-cards.ts";

describe("session progress card coalescing ownership", () => {
  it.each([
    { cachedRevision: 1, queuedRevision: 3, revision: 3, absent: false, reads: 2 },
    { cachedRevision: 1, queuedRevision: 3, revision: 2, absent: false, reads: 3 },
    { cachedRevision: 1, queuedRevision: 3, revision: null, absent: false, reads: 3 },
    { cachedRevision: 1, queuedRevision: null, revision: null, absent: true, reads: 3 },
    { cachedRevision: 3, queuedRevision: 2, revision: null, absent: true, reads: 3 },
  ])(
    "coalesces reads without ending an overtaken lifetime (cached $cachedRevision, queued $queuedRevision, response $revision)",
    async ({ cachedRevision, queuedRevision, revision, absent, reads }) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      const initial = { ...createProgressCard(1), revision: cachedRevision };
      const response = revision === null ? null : { ...initial, revision };
      const latest = absent ? null : { ...initial, revision: 4, markdown: "Latest" };
      const refresh = createDeferred<{ card: typeof response }>();
      const followUp = createDeferred<{ card: typeof latest }>();
      request
        .mockResolvedValueOnce({ card: initial })
        .mockReturnValueOnce(refresh.promise)
        .mockReturnValueOnce(followUp.promise);
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      const displayed = await store.load(target);
      const lifetime = store.getLifetime(target);
      expect(lifetime).toBeDefined();
      const publishedLifetimes: Array<object | undefined> = [];
      const unsubscribe = store.subscribe(() => publishedLifetimes.push(store.getLifetime(target)));
      onTestFinished(() => {
        unsubscribe();
        store.unwatch(owner);
        refresh.resolve({ card: response });
        followUp.resolve({ card: latest });
      });
      emitChange(sessionKey, cachedRevision + 1);
      const reading = store.load(target);
      emitChange(sessionKey, queuedRevision);
      emitChange(sessionKey, queuedRevision);
      expect(request).toHaveBeenCalledTimes(2);
      refresh.resolve({ card: response });
      await reading;
      expect(store.get(target)).toEqual(response ?? displayed);
      if (response === null) {
        expect(store.get(target)).toBe(displayed);
      }
      expect(store.getLifetime(target)).toBe(lifetime);
      expect(publishedLifetimes.every((token) => token === lifetime)).toBe(true);
      // Start automatically, even if the OLD cached revision satisfies the hint.
      expect(request).toHaveBeenCalledTimes(reads);
      if (reads === 3) {
        const confirming = store.load(target);
        followUp.resolve({ card: latest });
        await confirming;
        expect(store.get(target)).toEqual(latest);
        expect(store.getLifetime(target)).toBe(absent ? undefined : lifetime);
        expect(request).toHaveBeenCalledTimes(3);
      }
    },
  );

  it("does not let a late conditional dismissal overwrite a newer coalesced read", async () => {
    const { gateway, request, emitChange } = createGateway("agent:main:main");
    const target = { sessionKey };
    const initial = { ...createProgressCard(1), markdown: "Initial" };
    const stale = { ...initial, revision: 2, markdown: "Stale" };
    const latest = { ...initial, revision: 3, markdown: "Latest" };
    const refresh = createDeferred<{ card: typeof latest }>();
    const dismissal = createDeferred<{ card: typeof stale }>();
    request
      .mockResolvedValueOnce({ card: initial })
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(dismissal.promise);

    const store = sessionProgressCardsForGateway(gateway);
    const owner = {};
    store.watch(owner, [target]);
    onTestFinished(() => {
      refresh.resolve({ card: latest });
      dismissal.resolve({ card: stale });
      store.unwatch(owner);
    });

    const displayed = await store.load(target);
    if (!displayed) {
      throw new Error("Expected the initial progress card");
    }
    emitChange(sessionKey, 2);
    const reading = store.load(target);
    const clearing = store.dismiss(target, displayed);
    emitChange(sessionKey, 3);

    refresh.resolve({ card: latest });
    await expect(reading).resolves.toEqual(latest);
    expect(store.get(target)).toEqual(latest);

    dismissal.resolve({ card: stale });
    await expect(clearing).resolves.toBe(false);
    expect(store.get(target)).toEqual(latest);
  });

  it.each(
    (["absent", "newer", "failed"] as const).flatMap((outcome) =>
      [true, false].map((eventFirst) => ({ outcome, eventFirst })),
    ),
  )(
    "does not restore cleared progress from an overtaken read ($outcome follow-up, event first: $eventFirst)",
    async ({ outcome, eventFirst }) => {
      const { gateway, request, emitChange } = createGateway();
      const target = { sessionKey };
      const initial = createProgressCard(1);
      const latest = outcome === "newer" ? { ...initial, revision: 3 } : null;
      const oldRead = createDeferred<{ card: typeof initial }>();
      const put = createDeferred<{ card: null }>();
      const followUp = createDeferred<{ card: typeof latest }>();
      request
        .mockResolvedValueOnce({ card: initial })
        .mockReturnValueOnce(oldRead.promise)
        .mockReturnValueOnce(put.promise)
        .mockReturnValueOnce(followUp.promise);
      const store = sessionProgressCardsForGateway(gateway);
      const owner = {};
      store.watch(owner, [target]);
      onTestFinished(() => {
        store.unwatch(owner);
        oldRead.resolve({ card: initial });
        put.resolve({ card: null });
        followUp.resolve({ card: latest });
      });
      const displayed = await store.load(target);
      if (!displayed) {
        throw new Error("Expected the initial progress card");
      }
      const lifetime = store.getLifetime(target);
      emitChange(sessionKey, 2);
      const reading = store.load(target);
      const clearing = store.dismiss(target, displayed);
      if (eventFirst) {
        emitChange(sessionKey, null);
      }
      put.resolve({ card: null });
      await expect(clearing).resolves.toBe(true);
      if (!eventFirst) {
        emitChange(sessionKey, null);
      }
      expect(store.get(target)).toBeNull();
      expect(store.getLifetime(target)).toBeUndefined();
      if (outcome === "newer") {
        emitChange(sessionKey, 3);
      }
      oldRead.resolve({ card: initial });
      await reading;
      expect(store.get(target)).toBeNull();
      expect(store.getLifetime(target)).toBeUndefined();
      expect(request).toHaveBeenCalledTimes(4);
      const confirming = store.load(target);
      if (outcome === "failed") {
        const failure = new Error("Confirmation unavailable");
        const rejected = expect(confirming).rejects.toBe(failure);
        followUp.reject(failure);
        await rejected;
      } else {
        followUp.resolve({ card: latest });
        await expect(confirming).resolves.toEqual(latest);
      }
      expect(store.get(target)).toEqual(latest);
      expect(store.getLifetime(target)).not.toBe(lifetime);
      expect(request).toHaveBeenCalledTimes(4);
    },
  );
});
