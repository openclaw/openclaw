import { expect, it, vi } from "vitest";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  PREPARATION_KEY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";

const f = usePreparedPoolFixture();
const prune = (owner = f.pool()) =>
  f.store.pruneTerminalEnvironments({ canPruneDemand: owner.canPruneDemand });
const expectDemand = (leaseId: string | null, demandAtMs: number) =>
  expect(f.provider.notePreparedDemand).toHaveBeenLastCalledWith(
    { leaseId, profile: {} },
    { preparationKey: PREPARATION_KEY, demandAtMs },
  );

it.each(["available", "missing", "throwing"] as const)(
  "retains terminal demand beyond seven days (%s policy)",
  async (policyState) => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const source = await f.attachSeed("source");
    await f.teardown(source);
    const placements = createWorkerSessionPlacementStore({ database: f.database });
    const placement = (await placements.getAsync(`session:${source.environmentId}`))!;
    await placements.retireSessionPlacementAsync({
      sessionId: placement.sessionId,
      expectedState: "failed",
      expectedGeneration: placement.generation,
    });
    await f.reopenStore();
    f.nowMs += 8 * dayMs;
    f.provider.resolvePreparedIdleTimeoutMs = () => 10 * dayMs;
    const resolveProvider = () => {
      if (policyState === "throwing") {
        throw new Error("provider unavailable");
      }
      return policyState === "missing" ? undefined : f.provider;
    };
    const owner = f.pool({ resolveProvider });
    expect(await prune(owner)).toBe(0);
    expect(f.store.get(source.environmentId)?.lastActivatedAtMs).toBe(1_000);
    if (policyState === "available") {
      await f.schedule(owner);
      expect(f.reserves()).toMatchObject([{ preparation: { expiresAtMs: 1_000 + 10 * dayMs } }]);
    }
    f.nowMs += 2 * dayMs;
    // Policy recovery permits metadata cleanup only after the original deadline.
    expect(await prune()).toBe(1);
    expect(f.store.get(source.environmentId)).toBeUndefined();
  },
);

it("pins expiry to demand through maintenance and database reopen", async () => {
  await f.attachSeed("source");
  const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
  const owner = f.pool({ reconcile });
  await f.schedule(owner);
  const reserve = f.reserves()[0]!;
  expect(reserve.preparation).toMatchObject({ demandAtMs: 1_000, expiresAtMs: 2_000 });
  f.nowMs = 1_900;
  await f.schedule(owner);
  expect(f.reserves()).toEqual([reserve]);
  expect(f.provider.notePreparedDemand).not.toHaveBeenCalled();

  await f.reopenStore();
  f.nowMs = 2_000;
  await f.schedule(f.pool({ reconcile }));
  expect(f.reserves()).toHaveLength(1);
  expect(f.store.get(reserve.environmentId)).toMatchObject({
    destroyRequestedAtMs: 2_000,
    preparation: reserve.preparation,
  });
  expect(reconcile.mock.lastCall?.[0]).toMatchObject({ destroyRequestedAtMs: 2_000 });
  f.nowMs = 2_100;
  await f.schedule(f.pool());
  expect(f.reserves()).toHaveLength(1);
});

it("retains activated demand through teardown and database reopen", async () => {
  const source = await f.attachSeed("source");
  const owner = f.pool();
  await f.schedule(owner);
  const reserve = await f.ready(f.reserves()[0]!);
  await owner.noteDemand(reserve.environmentId);
  expect(f.provider.notePreparedDemand).not.toHaveBeenCalled();
  f.nowMs = 1_500;
  await owner.noteDemand(source.environmentId);
  expectDemand(source.leaseId, 1_000);
  const consumed = await f.attach(reserve);
  await owner.noteDemand(consumed.environmentId);
  expectDemand(consumed.leaseId, 1_500);
  await f.teardown(source);
  await f.teardown(consumed);
  await f.reopenStore();
  await f.schedule(f.pool());
  expect(
    f.reserves().find((record) => record.preparation?.consumedAtMs === null)?.preparation,
  ).toMatchObject({ demandAtMs: 1_500, expiresAtMs: 2_500 });
  expect(f.store.get(consumed.environmentId)?.preparation).toMatchObject({
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
    const source = await f.attachSeed("source");
    await f.schedule(f.pool());
    await f.teardown(source);
    const reserve = await f.ready(f.reserves()[0]!);
    f.nowMs = 1_900;
    const consumed = await f.attach(reserve, stage);
    if (fail) {
      await f.teardown(consumed);
    }
    await f.reopenStore();
    f.nowMs = 1_950;
    const owner = f.pool();
    await owner.noteDemand(consumed.environmentId);
    await f.schedule(owner);
    expect(f.provider.notePreparedDemand).not.toHaveBeenCalled();
    const replacement = f.reserves().filter((record) => record.preparation?.consumedAtMs === null);
    expect(replacement).toMatchObject([{ preparation: { demandAtMs: 1_000, expiresAtMs: 2_000 } }]);
    f.nowMs = 2_050;
    await f.schedule(owner);
    expect(f.reserves()).toHaveLength(2);
    expect(f.store.get(replacement[0]!.environmentId)?.destroyRequestedAtMs).toBe(2_050);
  },
);
