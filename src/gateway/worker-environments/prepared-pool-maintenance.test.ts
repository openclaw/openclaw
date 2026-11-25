import { expect, it, vi } from "vitest";
import { usePreparedPoolFixture, type PoolOptions } from "./prepared-pool.test-support.js";

const fixture = usePreparedPoolFixture();
const reconciledIds = (reconcile: ReturnType<typeof vi.fn<PoolOptions["reconcile"]>>) =>
  reconcile.mock.calls.map(([record]) => record.environmentId);
async function readyReserve() {
  await fixture.attachSeed("source");
  return fixture.readySeed("reserve", { reserve: true });
}

it("publishes current reservation identities through consumption, cleanup, and policy changes", async () => {
  const owner = fixture.pool();
  const expectSummary = (reservedEnvironmentIds: string[], maxTotal = 4) =>
    expect(owner.summary()).toEqual({ maxTotal, reservedEnvironmentIds });
  expectSummary([]);
  expect(owner.target("development")).toBe(1);
  expect(owner.target("missing")).toBe(0);

  const preparing = await fixture.seed("preparing", { purpose: "build" });
  const reserve = await fixture.readySeed("reserve", { reserve: true });
  expectSummary(["preparing", "reserve"]);

  const consumed = await fixture.attach(reserve);
  expectSummary(["preparing"]);
  await fixture.store.requestDestroy({
    environmentId: consumed.environmentId,
    state: consumed.state,
  });
  expectSummary(["reserve", "preparing"]);
  await fixture.teardown(consumed);
  expectSummary(["preparing"]);

  const orphaned = await fixture.attachSeed("orphaned", { reserve: true });
  await fixture.store.transition({
    environmentId: orphaned.environmentId,
    from: "attached",
    to: "orphaned",
  });
  const failed = await fixture.seed("failed", { reserve: true });
  await fixture.store.transition({
    environmentId: failed.environmentId,
    from: "requested",
    to: "failed",
  });
  expectSummary(["orphaned", "preparing"]);

  fixture.nowMs = preparing.preparation!.expiresAtMs;
  await fixture.store.requestPreparedDestroy({
    environmentId: preparing.environmentId,
    ownerEpoch: preparing.ownerEpoch,
    preparationKey: preparing.preparation!.key,
    reason: "expired",
    assertCurrent: () => {},
  });
  expectSummary(["orphaned", "preparing"]);

  fixture.developmentProfile.readyWorkers = 3;
  expect(owner.target("development")).toBe(3);
  fixture.developmentProfile.readyWorkers = 0;
  fixture.config.cloudWorkers!.preparedPool = { maxTotal: 0 };
  expect(owner.target("development")).toBe(0);
  expectSummary(["orphaned", "preparing"], 0);
});

it("keeps satisfied targets quiet and reports an unsatisfied shared cap", async () => {
  await readyReserve();
  const warn = vi.fn();
  const owner = fixture.pool({ warn });
  await fixture.schedule(owner);
  await fixture.schedule(owner);
  expect(warn).not.toHaveBeenCalled();

  fixture.developmentProfile.readyWorkers = 2;
  fixture.config.cloudWorkers!.preparedPool = { maxTotal: 1 };
  await fixture.schedule(owner);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/Prepared worker refill skipped .*: shared prepared capacity reached$/),
  );
  await fixture.schedule(owner);
  expect(warn).toHaveBeenCalledTimes(1);

  fixture.developmentProfile.readyWorkers = 1;
  await fixture.schedule(owner);
  fixture.developmentProfile.readyWorkers = 2;
  await fixture.schedule(owner);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(fixture.reserves()).toHaveLength(1);
});

it.each([
  "retention",
  "missing provider",
  "provider resolution",
  "idle timeout",
  "refill admission",
] as const)(
  "retains ready capacity during a %s outage and resumes on recovery",
  async (failure) => {
    fixture.developmentProfile.readyWorkers = 2;
    const reserve = await readyReserve();
    let recovered = false;
    const refillFailure = failure === "refill admission";
    const unavailable = new Error(
      refillFailure ? "GitHub request timed out" : `${failure} observation temporarily unavailable`,
    );
    const failWhileUnavailable = (stage: typeof failure) => {
      if (!recovered && failure === stage) {
        throw unavailable;
      }
    };
    const resolveProvider: PoolOptions["resolveProvider"] = () => {
      if (!recovered && failure === "missing provider") {
        return undefined;
      }
      failWhileUnavailable("provider resolution");
      return fixture.provider;
    };
    const resolveIdleTimeout = fixture.provider.resolvePreparedIdleTimeoutMs!;
    fixture.provider.resolvePreparedIdleTimeoutMs = (profile) => {
      failWhileUnavailable("idle timeout");
      return resolveIdleTimeout(profile);
    };
    const prepareRetention = vi.fn<PoolOptions["prepareRetention"]>(async () => ({
      isCurrent: () => true,
    }));
    if (failure === "retention") {
      prepareRetention.mockRejectedValueOnce(
        new Error(`Artifact archive temporarily unreadable (EBUSY): ${"x".repeat(4_096)}`),
      );
    }
    const prepareIntent = vi.fn<PoolOptions["prepareIntent"]>(async () => {
      failWhileUnavailable("refill admission");
      return fixture.intent();
    });
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
    if (refillFailure) {
      expect(reconciledIds(reconcile)).toEqual([reserve.environmentId]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitHub request timed out"));
    } else {
      expect(reconcile).not.toHaveBeenCalled();
    }
    expect(prepareIntent).toHaveBeenCalledTimes(refillFailure ? 1 : 0);
    expect(prepareRetention).toHaveBeenCalledOnce();
    const diagnostic = warn.mock.calls.map(([message]) => message).join("\n");
    expect(diagnostic).toContain(
      failure === "retention"
        ? "Artifact archive temporarily unreadable (EBUSY)"
        : failure === "missing provider"
          ? fixture.provider.id
          : unavailable.message,
    );
    expect(diagnostic.length).toBeLessThan(1_500);

    recovered = true;
    fixture.nowMs = 1_100;
    await fixture.schedule(owner);

    expect(fixture.store.get(reserve.environmentId)).toEqual(reserve);
    expect(reconciledIds(reconcile)).toContain(reserve.environmentId);
    expect(prepareIntent).toHaveBeenCalledTimes(refillFailure ? 2 : 1);
    expect(fixture.reserves()).toHaveLength(2);
  },
);

it.each(["expired", "disabled", "idle timeout", "retention during provider outage"] as const)(
  "retires ready capacity when %s establishes its cleanup policy",
  async (reason) => {
    const reserve = await readyReserve();
    const independentCleanup = reason === "expired" || reason === "disabled";
    if (reason === "expired") {
      fixture.nowMs = reserve.preparation!.expiresAtMs;
    } else if (reason === "disabled") {
      fixture.developmentProfile.readyWorkers = 0;
    } else if (reason === "idle timeout") {
      fixture.provider.resolvePreparedIdleTimeoutMs = () => undefined;
    }
    const prepareRetention = vi.fn<PoolOptions["prepareRetention"]>(async () => {
      throw new Error("Artifact archive temporarily unavailable");
    });
    const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
    const owner = fixture.pool({
      ...(independentCleanup ? { prepareRetention } : {}),
      ...(reason === "retention during provider outage"
        ? { resolveProvider: () => undefined, prepareRetention: async () => undefined }
        : {}),
      reconcile,
    });
    await fixture.schedule(owner);
    expect(fixture.store.get(reserve.environmentId)).toMatchObject({
      destroyRequestedAtMs: fixture.nowMs,
      ...(independentCleanup ? { preparation: reserve.preparation } : {}),
    });
    expect(reconciledIds(reconcile)).toEqual([reserve.environmentId]);
    if (independentCleanup) {
      expect(prepareRetention).not.toHaveBeenCalled();
    }
  },
);

it("starts expired reserve cleanup before awaiting unrelated source admission", async () => {
  const expired = await fixture.readySeed("expired", { reserve: true });
  fixture.nowMs = 1_500;
  const projectKey = "1".repeat(64);
  await fixture.attachSeed("source", { projectKey });
  fixture.nowMs = 2_000;
  const { entered, release } = fixture.gate();
  const reconcile = vi.fn<PoolOptions["reconcile"]>(async () => {});
  const owner = fixture.pool({
    reconcile,
    prepareIntent: async () => {
      entered.resolve();
      await release.promise;
      return fixture.intent(projectKey);
    },
  });
  const running = fixture.schedule(owner);
  try {
    await Promise.race([entered.promise, running]);
    expect(fixture.store.get(expired.environmentId)?.destroyRequestedAtMs).toBe(2_000);
    expect(reconcile.mock.calls.map(([record]) => record)).toContainEqual(
      expect.objectContaining({
        environmentId: expired.environmentId,
        destroyRequestedAtMs: 2_000,
      }),
    );
  } finally {
    release.resolve();
    await running;
  }
});
