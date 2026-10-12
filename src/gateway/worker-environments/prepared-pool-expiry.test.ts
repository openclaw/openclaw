import { describe, expect, it, vi } from "vitest";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  PREPARATION_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";

describe("prepared worker demand expiry", () => {
  const fixture = usePreparedPoolFixture();

  it.each(["available", "missing", "throwing"] as const)(
    "retains terminal demand beyond seven days with %s provider policy",
    async (policyState) => {
      const dayMs = 24 * 60 * 60 * 1_000;
      const source = await fixture.attach(await fixture.ready(await fixture.seed("source")));
      await fixture.teardown(source);
      const placements = createWorkerSessionPlacementStore({ database: fixture.database });
      const placement = placements.get(`session:${source.environmentId}`)!;
      placements.retireSessionPlacement({
        sessionId: placement.sessionId,
        expectedState: "failed",
        expectedGeneration: placement.generation,
      });
      await fixture.reopenStore();
      fixture.nowMs += 8 * dayMs;
      fixture.provider.resolvePreparedIdleTimeoutMs = () => 10 * dayMs;
      const resolveProvider = () => {
        if (policyState === "throwing") {
          throw new Error("provider unavailable");
        }
        return policyState === "missing" ? undefined : fixture.provider;
      };
      const owner = fixture.pool({ resolveProvider });
      expect(
        await fixture.store.pruneTerminalEnvironments({ canPruneDemand: owner.canPruneDemand }),
      ).toBe(0);
      expect(fixture.store.get(source.environmentId)?.lastActivatedAtMs).toBe(1_000);
      if (policyState === "available") {
        await fixture.schedule(owner);
        expect(fixture.reserves()).toHaveLength(1);
        expect(fixture.reserves()[0]?.preparation?.expiresAtMs).toBe(1_000 + 10 * dayMs);
      }
      fixture.nowMs += 2 * dayMs;
      // Policy recovery permits metadata cleanup only after the original deadline.
      expect(
        await fixture.store.pruneTerminalEnvironments({
          canPruneDemand: fixture.pool().canPruneDemand,
        }),
      ).toBe(1);
      expect(fixture.store.get(source.environmentId)).toBeUndefined();
    },
  );

  it("keeps expiry tied to originating demand across repeated maintenance and database reopen", async () => {
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({ reconcile });
    await fixture.schedule(owner);
    const reserve = fixture.reserves()[0]!;
    expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
    fixture.nowMs = 1_900;
    await fixture.schedule(owner);
    expect(fixture.reserves()).toEqual([reserve]);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();

    await fixture.reopenStore();
    fixture.nowMs = 2_000;
    await fixture.schedule(fixture.pool({ reconcile }));
    expect(fixture.reserves()).toHaveLength(1);
    expect(fixture.store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: 2_000,
      preparation: reserve.preparation,
    });
    expect(reconcile.mock.lastCall?.[0]).toMatchObject({ destroyRequestedAtMs: 2_000 });
    fixture.nowMs = 2_100;
    await fixture.schedule(fixture.pool());
    expect(fixture.reserves()).toHaveLength(1);
  });

  it("retains activated demand after consumed worker teardown and database reopen", async () => {
    const source = await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const owner = fixture.pool();
    await fixture.schedule(owner);
    const reserve = await fixture.ready(fixture.reserves()[0]!);
    await owner.noteDemand(reserve.environmentId);
    expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
    fixture.nowMs = 1_500;
    await owner.noteDemand(source.environmentId);
    expect(fixture.provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: source.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_000 },
    );
    const consumed = await fixture.attach(reserve);
    await owner.noteDemand(consumed.environmentId);
    expect(fixture.provider.notePreparedDemand).toHaveBeenLastCalledWith(
      { leaseId: consumed.leaseId, profile: {} },
      { preparationKey: PREPARATION_KEY, demandAtMs: 1_500 },
    );
    await fixture.teardown(source);
    await fixture.teardown(consumed);
    await fixture.reopenStore();
    await fixture.schedule(fixture.pool());
    expect(
      fixture.reserves().find((record) => record.preparation?.consumedAtMs === null)?.preparation,
    ).toMatchObject({ demandAtMs: 1_500, expiresAtMs: 2_500 });
    expect(fixture.store.get(consumed.environmentId)?.preparation).toMatchObject({
      consumedAtMs: 1_500,
      expiresAtMs: 2_000,
    });
  });

  it.each([
    ["provisioning", true],
    ["syncing", false],
  ] as const)(
    "does not renew consumed %s demand (failed=%s) before or after expiry",
    async (stage, fail) => {
      const source = await fixture.attach(await fixture.ready(await fixture.seed("source")));
      await fixture.schedule(fixture.pool());
      await fixture.teardown(source);
      const reserve = await fixture.ready(fixture.reserves()[0]!);
      fixture.nowMs = 1_900;
      const consumed = await fixture.attach(reserve, stage);
      if (fail) {
        await fixture.teardown(consumed);
      }
      await fixture.reopenStore();
      fixture.nowMs = 1_950;
      const owner = fixture.pool();
      await owner.noteDemand(consumed.environmentId);
      await fixture.schedule(owner);
      expect(fixture.provider.notePreparedDemand).not.toHaveBeenCalled();
      const replacement = fixture
        .reserves()
        .filter((record) => record.preparation?.consumedAtMs === null);
      expect(replacement).toHaveLength(1);
      expect(replacement[0]?.preparation).toMatchObject({
        demandAtMs: 1_000,
        expiresAtMs: 2_000,
      });
      fixture.nowMs = 2_050;
      await fixture.schedule(owner);
      expect(fixture.reserves()).toHaveLength(2);
      expect(fixture.store.get(replacement[0]!.environmentId)?.destroyRequestedAtMs).toBe(2_050);
    },
  );
});
