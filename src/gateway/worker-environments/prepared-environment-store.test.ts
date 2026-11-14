import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import type { WorkerRetentionPolicy } from "../../plugins/worker-retention.types.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import type { PreparedEnvironmentSelection } from "./environment-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { usePreparedPoolFixture } from "./prepared-pool.test-support.js";

const PROJECT_KEY = "a".repeat(64);
const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
const assertCurrent = () => undefined;

describe("prepared environment ownership", () => {
  const fixture = usePreparedPoolFixture();
  let environments: typeof fixture.store;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  const createPlacements = () =>
    createWorkerSessionPlacementStore({
      database: fixture.database,
      now: () => fixture.nowMs,
    });
  const openStores = () => {
    environments = fixture.store;
    placements = createPlacements();
  };
  const reopenStores = async () => {
    await fixture.reopenStore();
    openStores();
  };
  beforeEach(openStores);

  const environment = { environmentId: "prepared-1" };
  const reservation = {
    ...environment,
    ownerEpoch: 1,
    preparationKey: PREPARATION_KEY,
    assertCurrent,
  };
  function reserve(
    environmentId = "prepared-1",
    purpose: "reserve" | "build" = "reserve",
    retention?: WorkerRetentionPolicy,
  ) {
    return environments.ensurePreparedIntent({
      intent: {
        environmentId,
        providerId: "test-provider",
        profileId: "test-profile",
        provisionOperationId: `provision:${environmentId}`,
        profileSnapshot: fixture.profile(PROJECT_KEY),
        retention,
        preparation: { purpose, key: PREPARATION_KEY, demandAtMs: 900, expiresAtMs: 2_000 },
      },
      projectKey: PROJECT_KEY,
      target: purpose === "build" ? 0 : 1,
      maxTotal: purpose === "build" ? 1 : 4,
      assertCurrent,
    });
  }
  async function ready() {
    return fixture.ready((await reserve())!);
  }
  async function selection(sessionId = "session-1"): Promise<PreparedEnvironmentSelection> {
    const identity = {
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      agentId: "main",
      executionMode: "worker-turn" as const,
    };
    const placement = await placements.startDispatch(identity);
    return {
      ...identity,
      expectedGeneration: placement.generation,
      ...reservation,
      providerId: "test-provider",
      profileId: "test-profile",
      nodeDeviceId: "node:prepared-1",
      leaseId: "lease:prepared-1",
      bundleHash: BUNDLE_HASH,
    };
  }
  function expiry() {
    return environments.requestPreparedDestroy({ ...reservation, reason: "expired" });
  }

  function unconsumed(sessionId: string) {
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
    expect(placements.get(sessionId)?.state).toBe("requested");
  }

  it("admits a build at zero ready target and preserves its purpose on reopen", async () => {
    expect((await reserve("build-1", "build"))?.preparation?.purpose).toBe("build");
    const capacity = { environmentId: "build-1", target: 0, maxTotal: 1 };
    expect(environments.isPreparedIntentWithinCapacity(capacity)).toBe(true);
    await reopenStores();
    expect(environments.get("build-1")?.preparation?.purpose).toBe("build");
    await expect(
      reserve("build-1", "build", {
        version: 1,
        ownerBinding: "session-original",
        computeWindowSeconds: 600,
      }),
    ).rejects.toThrow("intent identity changed");
    expect(await reserve("build-2", "build")).toEqual(environments.get("build-1"));
    expect(environments.list()).toHaveLength(1);
  });

  it("assigns once across store instances and retains consumption after placement deletion and reopen", async () => {
    await ready();
    const first = await selection();
    const second = await selection("session-2");
    const sql = observeMainThreadSql();
    let assigned: NonNullable<Awaited<ReturnType<typeof placements.bindPreparedEnvironment>>>;
    try {
      assigned = (await placements.bindPreparedEnvironment(first))!;
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(assigned).toMatchObject({ state: "provisioning", environmentId: "prepared-1" });
    const anotherStore = createPlacements();
    expect(await anotherStore.bindPreparedEnvironment(second)).toBeUndefined();
    const failed = await placements.fail({
      sessionId: first.sessionId,
      expectedGeneration: assigned.generation,
      recoveryError: "assignment cancelled",
    });
    await placements.retireSessionPlacementAsync({
      sessionId: first.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    await reopenStores();
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBe(1_000);
    expect(await placements.bindPreparedEnvironment(second)).toBeUndefined();
    expect((await placements.getAsync(second.sessionId))?.state).toBe("requested");
  });

  it.each(["claim-first", "expire-first"] as const)(
    "excludes claim and expiry in %s order",
    async (order) => {
      await ready();
      const request = await selection();
      if (order === "claim-first") {
        expect((await placements.bindPreparedEnvironment(request))?.state).toBe("provisioning");
        fixture.nowMs = 2_000;
        expect(await expiry()).toBeUndefined();
        expect(environments.get("prepared-1")?.destroyRequestedAtMs).toBeNull();
      } else {
        fixture.nowMs = 2_000;
        expect((await expiry())?.destroyRequestedAtMs).toBe(2_000);
        expect(await placements.bindPreparedEnvironment(request)).toBeUndefined();
        expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
      }
    },
  );

  it.each([{ ownerEpoch: 2 }, { sessionKey: "agent:main:other" }, { expectedGeneration: 999 }])(
    "rejects stale selection without consuming capacity: %j",
    async (changed) => {
      await ready();
      const request = await selection();
      expect(await placements.bindPreparedEnvironment({ ...request, ...changed })).toBeUndefined();
      unconsumed(request.sessionId);
    },
  );

  it.each(["transaction", "commit"] as const)(
    "rolls back a prepared assignment when authority ends at %s admission",
    async (stage) => {
      await ready();
      const request = await selection();
      let revoked = false;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementationOnce((admit, attachment) =>
          createAdmission((entry, grant) => {
            if (entry.stage === stage) {
              revoked = true;
            }
            admit(entry, grant);
          }, attachment),
        );
      onTestFinished(() => admission.mockRestore());
      await expect(
        placements.bindPreparedEnvironment({
          ...request,
          assertCurrent: () => {
            if (revoked) {
              throw new Error("caller revoked");
            }
          },
        }),
      ).rejects.toThrow("caller revoked");
      unconsumed(request.sessionId);
    },
  );

  it("requires the exact reservation after expiry and reopen and cannot recycle its rollback", async () => {
    await ready();
    const request = await selection();
    const assigned = (await placements.bindPreparedEnvironment(request))!;
    fixture.nowMs = 2_001;
    await reopenStores();
    const syncing = await placements.transition({
      sessionId: request.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: assigned.generation,
      patch: { workerBundleHash: BUNDLE_HASH },
    });
    const attach = {
      ...environment,
      from: "ready" as const,
      to: "attached" as const,
      expectedOwnerEpoch: 1,
      patch: {
        attachedSessionIds: [request.sessionId],
        credential: fixture.credential("attached-credential", request.sessionId),
      },
    };
    await expect(environments.transition(attach)).rejects.toThrow("exact placement reservation");
    const binding = { ...request, generation: syncing.generation };
    await expect(
      environments.transition({ ...attach, placementBinding: { ...binding, generation: 0 } }),
    ).rejects.toThrow("exact placement reservation");
    expect((await environments.transition({ ...attach, placementBinding: binding })).state).toBe(
      "attached",
    );
    const idle = await environments.transition({ ...environment, from: "attached", to: "idle" });
    expect(idle.preparation?.consumedAtMs).toBe(1_000);
    await expect(
      environments.transition({
        ...attach,
        from: "idle",
        expectedOwnerEpoch: idle.ownerEpoch,
        placementBinding: binding,
      }),
    ).rejects.toThrow("exact placement reservation");
  });
});
