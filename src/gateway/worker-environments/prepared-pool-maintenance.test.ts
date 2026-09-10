import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  PREPARATION_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";

describe("prepared pool retention and source admission", () => {
  const fixture = usePreparedPoolFixture();

  it("does not read source admission while ready capacity is full after restart", async () => {
    fixture.attach(fixture.ready(fixture.seed("source")));
    const reserve = fixture.ready(fixture.seed("reserve", { reserve: true }));
    fixture.reopenStore();
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async () => ({
      providerId: fixture.provider.id,
      profileSnapshot: fixture.profile(),
      preparationKey: PREPARATION_KEY,
    }));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({ prepareIntent, reconcile });
    await fixture.schedule(owner);
    fixture.nowMs = 1_100;
    await fixture.schedule(owner);
    expect(prepareIntent).not.toHaveBeenCalled();
    expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
  });

  it("starts expired reserve cleanup before awaiting unrelated source admission", async () => {
    const expired = fixture.ready(fixture.seed("expired", { reserve: true }));
    fixture.nowMs = 1_500;
    const projectKey = "1".repeat(64);
    fixture.attach(fixture.ready(fixture.seed("source", { projectKey })));
    fixture.nowMs = 2_000;
    const entered = createDeferred();
    const release = createDeferred();
    fixture.releases.push(() => release.resolve());
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({
      reconcile,
      prepareIntent: async () => {
        entered.resolve();
        await release.promise;
        return {
          providerId: fixture.provider.id,
          profileSnapshot: fixture.profile(projectKey),
          preparationKey: PREPARATION_KEY,
        };
      },
    });
    const running = fixture.schedule(owner);
    try {
      await Promise.race([entered.promise, running]);
      expect(fixture.store.get(expired.environmentId)?.destroyRequestedAtMs).toBe(2_000);
      expect(reconcile.mock.calls.map(([record]) => record)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            environmentId: expired.environmentId,
            destroyRequestedAtMs: 2_000,
          }),
        ]),
      );
    } finally {
      release.resolve();
      await running;
    }
  });
});
