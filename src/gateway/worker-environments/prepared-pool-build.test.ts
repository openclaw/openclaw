import { expect, it, vi } from "vitest";
import {
  IDLE_TIMEOUT_MS,
  PRESENCE_REPOSITORY,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";

const f = usePreparedPoolFixture();

it.each(["new build", "promoted reserve"] as const)(
  "retains a %s during another project's pending retention",
  async (admission) => {
    f.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
    await f.attachSeed("source-a");
    const projectKey = "1".repeat(64);
    const preparationKey = "2".repeat(64);
    const reserve =
      admission === "promoted reserve"
        ? await f.seed("reserve-b", { reserve: true, projectKey, preparationKey })
        : undefined;
    const { entered, release } = f.gate();
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>();
    const owner = f.pool({
      reconcile,
      prepareIntent,
      prepareRetention: async (record) => {
        if (record.environmentId === "source-a") {
          entered.resolve();
          await release.promise;
        }
        return { isCurrent: () => true };
      },
    });
    const running = f.schedule(owner);
    await Promise.race([entered.promise, running]);
    f.nowMs += 100;
    f.developmentProfile.readyWorkers = 0;
    const build = (await f.store.ensurePreparedIntent({
      intent: {
        environmentId: "build-b",
        providerId: f.provider.id,
        profileId: "development",
        provisionOperationId: "provision:build-b",
        profileSnapshot: f.profile(projectKey, preparationKey),
        preparation: {
          purpose: "build",
          key: preparationKey,
          demandAtMs: f.nowMs,
          expiresAtMs: f.nowMs + IDLE_TIMEOUT_MS,
        },
      },
      projectKey,
      target: 0,
      maxTotal: 1,
      assertCurrent: () => {},
    }))!;
    expect(build).toMatchObject({ environmentId: reserve?.environmentId ?? "build-b" });
    const repeated = f.schedule(owner);
    release.resolve();
    await Promise.all([running, repeated]);
    expect(f.store.get(build.environmentId)).toMatchObject({
      state: "requested",
      destroyRequestedAtMs: null,
      preparation: {
        purpose: "build",
        expiresAtMs: reserve?.preparation?.expiresAtMs ?? f.nowMs + IDLE_TIMEOUT_MS,
      },
    });
    expect(f.reserves()).toHaveLength(1);
    expect(prepareIntent).not.toHaveBeenCalled();
    expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toContain(
      build.environmentId,
    );
  },
);

it("leaves repository builds with their request owner while still expiring them", async () => {
  const build = await f.seed("repository-build", {
    purpose: "build",
    repository: PRESENCE_REPOSITORY,
  });
  const prepareRetention = vi.fn<PoolOptions["prepareRetention"]>();
  const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>();
  const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
  const owner = f.pool({ prepareRetention, prepareIntent, reconcile });
  await f.schedule(owner);
  expect(f.store.get(build.environmentId)).toMatchObject({
    state: "requested",
    destroyRequestedAtMs: null,
  });
  expect(prepareRetention).not.toHaveBeenCalled();
  expect(prepareIntent).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  f.nowMs += IDLE_TIMEOUT_MS;
  await f.schedule(owner);
  expect(f.store.get(build.environmentId)?.destroyRequestedAtMs).toBe(f.nowMs);
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ environmentId: build.environmentId, destroyRequestedAtMs: f.nowMs }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(f.reserves()).toHaveLength(1);
});

it("prefers a new build to a commit activated in the same millisecond", async () => {
  f.developmentProfile.readyWorkers = 0;
  await f.attachSeed("previous-source");
  const build = await f.seed("build", { purpose: "build", preparationKey: "e".repeat(64) });
  await f.schedule(f.pool());
  expect(f.store.get(build.environmentId)?.destroyRequestedAtMs).toBeNull();
});

it.each([0, 1])("finishes a build before applying the ready target %i", async (target) => {
  f.developmentProfile.readyWorkers = target;
  const build = await f.seed("build", { purpose: "build" });
  const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
  const owner = f.pool({ reconcile });
  await f.schedule(owner);
  await f.schedule(owner);
  expect(f.store.get(build.environmentId)).toMatchObject({
    state: "requested",
    destroyRequestedAtMs: null,
    preparation: { purpose: "build" },
  });
  expect(reconcile).toHaveBeenCalledTimes(2);
  await f.ready(build);
  await f.schedule(owner);
  expect(f.store.get(build.environmentId)?.destroyRequestedAtMs).toBe(
    target === 0 ? f.nowMs : null,
  );
  expect(f.reserves()).toHaveLength(1);
});

it("records build demand for subsequent ordinary reserve refill", async () => {
  f.developmentProfile.readyWorkers = 0;
  const build = await f.readySeed("build", { purpose: "build" });
  const owner = f.pool();
  await f.schedule(owner);
  await f.destroy(build);
  f.developmentProfile.readyWorkers = 1;
  f.nowMs += 100;
  await f.schedule(owner);
  expect(f.reserves().find((record) => record.environmentId !== build.environmentId)).toMatchObject(
    {
      state: "requested",
      preparation: { purpose: "reserve", demandAtMs: 1_000, expiresAtMs: 1_000 + IDLE_TIMEOUT_MS },
    },
  );
});

it.each(["expiry", "removed profile", "replaced provider", "global cap"] as const)(
  "retires an unfinished build on %s",
  async (invalidation) => {
    f.developmentProfile.readyWorkers = 0;
    const build = await f.seed("build", { purpose: "build" });
    switch (invalidation) {
      case "expiry":
        f.nowMs += IDLE_TIMEOUT_MS;
        break;
      case "removed profile":
        delete f.config.cloudWorkers!.profiles!.development;
        break;
      case "replaced provider":
        f.developmentProfile.provider = "other-provider";
        break;
      case "global cap":
        f.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
    }
    await f.schedule(f.pool());
    expect(f.store.get(build.environmentId)?.destroyRequestedAtMs).toBe(f.nowMs);
  },
);
