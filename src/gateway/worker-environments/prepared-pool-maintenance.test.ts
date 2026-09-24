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
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
    await fixture.reopenStore();
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

  it("retains ready capacity through an unavailable retention check and resumes on recovery", async () => {
    fixture.developmentProfile.readyWorkers = 2;
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
    const prepareRetention = vi
      .fn<PoolOptions["prepareRetention"]>(async () => ({ isCurrent: () => true }))
      .mockRejectedValueOnce(
        new Error(`Artifact archive temporarily unreadable (EBUSY): ${"x".repeat(4_096)}`),
      );
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async () => ({
      providerId: fixture.provider.id,
      profileSnapshot: fixture.profile(),
      preparationKey: PREPARATION_KEY,
    }));
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const warn = vi.fn<PoolOptions["warn"]>();
    const owner = fixture.pool({ prepareRetention, prepareIntent, reconcile, warn });

    await fixture.schedule(owner);

    expect(fixture.reserves()).toEqual([reserve]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(prepareIntent).not.toHaveBeenCalled();
    const diagnostic = warn.mock.calls.map(([message]) => message).join("\n");
    expect(diagnostic).toContain("Artifact archive temporarily unreadable (EBUSY)");
    expect(diagnostic.length).toBeLessThan(1_500);

    fixture.nowMs = 1_100;
    await fixture.schedule(owner);

    expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
    expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toContain(
      reserve.environmentId,
    );
    expect(prepareIntent).toHaveBeenCalledOnce();
    expect(fixture.reserves()).toHaveLength(2);
  });

  it.each(["missing provider", "provider resolution", "idle timeout"] as const)(
    "retains ready capacity during a %s outage and resumes on recovery",
    async (failure) => {
      fixture.developmentProfile.readyWorkers = 2;
      await fixture.attach(await fixture.ready(await fixture.seed("source")));
      const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
      let recovered = false;
      const unavailable = new Error(`${failure} observation temporarily unavailable`);
      const resolveProvider: PoolOptions["resolveProvider"] = () => {
        if (!recovered && failure === "missing provider") {
          return undefined;
        }
        if (!recovered && failure === "provider resolution") {
          throw unavailable;
        }
        return fixture.provider;
      };
      const resolveIdleTimeout = fixture.provider.resolvePreparedIdleTimeoutMs!;
      fixture.provider.resolvePreparedIdleTimeoutMs = (profile) => {
        if (!recovered && failure === "idle timeout") {
          throw unavailable;
        }
        return resolveIdleTimeout(profile);
      };
      const prepareRetention = vi.fn<PoolOptions["prepareRetention"]>(async () => ({
        isCurrent: () => true,
      }));
      const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async () => ({
        providerId: fixture.provider.id,
        profileSnapshot: fixture.profile(),
        preparationKey: PREPARATION_KEY,
      }));
      const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
      const warn = vi.fn<PoolOptions["warn"]>();
      const owner = fixture.pool({
        resolveProvider,
        prepareRetention,
        prepareIntent,
        reconcile,
        warn,
      });

      await fixture.schedule(owner);

      expect(fixture.reserves()).toEqual([reserve]);
      expect(reconcile).not.toHaveBeenCalled();
      expect(prepareIntent).not.toHaveBeenCalled();
      expect(prepareRetention).toHaveBeenCalledOnce();
      const diagnostic = warn.mock.calls.map(([message]) => message).join("\n");
      expect(diagnostic).toContain(
        failure === "missing provider" ? fixture.provider.id : unavailable.message,
      );

      recovered = true;
      fixture.nowMs = 1_100;
      await fixture.schedule(owner);

      expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
      expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toContain(
        reserve.environmentId,
      );
      expect(prepareIntent).toHaveBeenCalledOnce();
      expect(fixture.reserves()).toHaveLength(2);
    },
  );

  it.each(["expired", "disabled"] as const)(
    "cleans up %s capacity without waiting for an unavailable retention check",
    async (reason) => {
      await fixture.attach(await fixture.ready(await fixture.seed("source")));
      const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
      if (reason === "expired") {
        fixture.nowMs = reserve.preparation!.expiresAtMs;
      } else {
        fixture.developmentProfile.readyWorkers = 0;
      }
      const prepareRetention = vi.fn<PoolOptions["prepareRetention"]>(async () => {
        throw new Error("Artifact archive temporarily unavailable");
      });
      const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
      const owner = fixture.pool({ prepareRetention, reconcile });

      await fixture.schedule(owner);

      expect(fixture.store.get(reserve.environmentId)).toMatchObject({
        destroyRequestedAtMs: fixture.nowMs,
        preparation: reserve.preparation,
      });
      expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toEqual([
        reserve.environmentId,
      ]);
      expect(prepareRetention).not.toHaveBeenCalled();
    },
  );

  it("keeps compatible ready capacity when admission for a refill fails", async () => {
    fixture.developmentProfile.readyWorkers = 2;
    await fixture.attach(await fixture.ready(await fixture.seed("source")));
    const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async () => {
      throw new Error("GitHub request timed out");
    });
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const warn = vi.fn<PoolOptions["warn"]>();
    const owner = fixture.pool({ prepareIntent, reconcile, warn });

    await fixture.schedule(owner);

    expect(prepareIntent).toHaveBeenCalledOnce();
    expect(fixture.reserves()).toEqual([reserve]);
    expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toEqual([
      reserve.environmentId,
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitHub request timed out"));
  });

  it.each(["retention", "idle timeout", "retention during provider outage"] as const)(
    "retires ready capacity when %s confirms incompatibility",
    async (incompatibility) => {
      await fixture.attach(await fixture.ready(await fixture.seed("source")));
      const reserve = await fixture.ready(await fixture.seed("reserve", { reserve: true }));
      const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
      if (incompatibility === "idle timeout") {
        fixture.provider.resolvePreparedIdleTimeoutMs = () => undefined;
      }
      const owner = fixture.pool({
        ...(incompatibility === "retention during provider outage"
          ? { resolveProvider: () => undefined }
          : {}),
        ...(incompatibility !== "idle timeout" ? { prepareRetention: async () => undefined } : {}),
        reconcile,
      });

      await fixture.schedule(owner);

      expect(fixture.store.get(reserve.environmentId)?.destroyRequestedAtMs).toBe(fixture.nowMs);
      expect(reconcile.mock.calls.map(([record]) => record.environmentId)).toEqual([
        reserve.environmentId,
      ]);
    },
  );

  it("starts expired reserve cleanup before awaiting unrelated source admission", async () => {
    const expired = await fixture.ready(await fixture.seed("expired", { reserve: true }));
    fixture.nowMs = 1_500;
    const projectKey = "1".repeat(64);
    await fixture.attach(await fixture.ready(await fixture.seed("source", { projectKey })));
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
