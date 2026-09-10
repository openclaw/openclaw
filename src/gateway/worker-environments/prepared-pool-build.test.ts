import { describe, expect, it, vi } from "vitest";
import {
  IDLE_TIMEOUT_MS,
  usePreparedPoolFixture,
  type PoolOptions,
} from "./prepared-pool.test-support.js";

describe("prepared worker builds", () => {
  const fixture = usePreparedPoolFixture();

  it("prefers a new build over an older commit activated in the same millisecond", async () => {
    fixture.developmentProfile.readyWorkers = 0;
    fixture.attach(fixture.ready(fixture.seed("previous-source")));
    const build = fixture.seed("build", { purpose: "build", preparationKey: "e".repeat(64) });
    await fixture.schedule(fixture.pool());
    expect(fixture.store.get(build.environmentId)?.destroyRequestedAtMs).toBeNull();
  });

  it.each([0, 1])("finishes a build before applying the ready target %i", async (target) => {
    fixture.developmentProfile.readyWorkers = target;
    const build = fixture.seed("build", { purpose: "build" });
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({ reconcile });
    await fixture.schedule(owner);
    await fixture.schedule(owner);
    expect(fixture.store.get(build.environmentId)).toMatchObject({
      state: "requested",
      destroyRequestedAtMs: null,
      preparation: { purpose: "build" },
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
    fixture.ready(build);
    await fixture.schedule(owner);
    expect(fixture.store.get(build.environmentId)?.destroyRequestedAtMs).toBe(
      target === 0 ? fixture.nowMs : null,
    );
    expect(fixture.reserves()).toHaveLength(1);
  });

  it("records build demand for subsequent ordinary reserve refill", async () => {
    fixture.developmentProfile.readyWorkers = 0;
    const build = fixture.ready(fixture.seed("build", { purpose: "build" }));
    const owner = fixture.pool();
    await fixture.schedule(owner);
    fixture.destroy(build);
    fixture.developmentProfile.readyWorkers = 1;
    fixture.nowMs += 100;
    await fixture.schedule(owner);
    expect(
      fixture.reserves().find((record) => record.environmentId !== build.environmentId),
    ).toMatchObject({
      state: "requested",
      preparation: { purpose: "reserve", demandAtMs: 1_000, expiresAtMs: 1_000 + IDLE_TIMEOUT_MS },
    });
  });

  it.each(["expiry", "removed profile", "replaced provider", "global cap"])(
    "retires an unfinished build when its %s invalidates admission",
    async (invalidation) => {
      fixture.developmentProfile.readyWorkers = 0;
      const build = fixture.seed("build", { purpose: "build" });
      if (invalidation === "expiry") {
        fixture.nowMs += IDLE_TIMEOUT_MS;
      } else if (invalidation === "removed profile") {
        delete fixture.config.cloudWorkers!.profiles!.development;
      } else if (invalidation === "replaced provider") {
        fixture.developmentProfile.provider = "other-provider";
      } else {
        fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
      }
      await fixture.schedule(fixture.pool());
      expect(fixture.store.get(build.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
    },
  );
});
