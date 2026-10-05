import { beforeEach, describe, expect, it, vi } from "vitest";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { hashWorkerCredential } from "./credential.js";
import type {
  PreparedEnvironmentSelection,
  WorkerEnvironmentIntentInput,
} from "./environment-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerEnvironmentStore } from "./store.js";

const PROJECT_KEY = "a".repeat(64);
const PREPARATION_KEY = "b".repeat(64);
const BUNDLE_HASH = "c".repeat(64);
const assertCurrent = () => undefined;

// These exercise the shared database, since process-local exclusion cannot protect
// a consumed machine after placement retirement or a second store opens the file.
describe("prepared environment ownership", () => {
  const tempDirs = useStateDatabaseTempDirs();
  let root: string;
  let database: OpenClawStateDatabase;
  let environments: Awaited<ReturnType<typeof createWorkerEnvironmentStore>>;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  let nowMs: number;

  const openStores = async () => {
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    environments = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    placements = createWorkerSessionPlacementStore({ database, now: () => nowMs });
  };
  const reopenStores = async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await openStores();
  };
  beforeEach(async () => {
    root = tempDirs.make("openclaw-prepared-");
    nowMs = 1_000;
    await openStores();
  });

  function intent(environmentId = "prepared-1", key = PREPARATION_KEY) {
    return {
      environmentId,
      providerId: "test-provider",
      profileId: "test-profile",
      provisionOperationId: `provision:${environmentId}`,
      profileSnapshot: {
        settings: {},
        executionMode: "worker-turn",
        project: { key: PROJECT_KEY, root: "/project", baseCommit: "d".repeat(40) },
      },
      preparation: { purpose: "reserve", key, demandAtMs: 900, expiresAtMs: 2_000 },
    } satisfies WorkerEnvironmentIntentInput;
  }
  function reserve(
    environmentId = "prepared-1",
    key = PREPARATION_KEY,
    maxTotal = 4,
    providerId = "test-provider",
  ) {
    return environments.ensurePreparedIntent({
      intent: { ...intent(environmentId, key), providerId },
      projectKey: PROJECT_KEY,
      target: 1,
      maxTotal,
      assertCurrent,
    });
  }
  async function ready() {
    await reserve();
    await environments.transition({
      environmentId: "prepared-1",
      from: "requested",
      to: "provisioning",
    });
    return environments.transition({
      environmentId: "prepared-1",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "lease-1",
        nodeDeviceId: "node-1",
        sharedHost: false,
        bootstrapReceipt: {
          bundleHash: BUNDLE_HASH,
          openclawVersion: "2026.8.1",
          protocolFeatures: [],
        },
        credential: {
          credentialHash: hashWorkerCredential("ready-credential"),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 10_000,
        },
      },
    });
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
      environmentId: "prepared-1",
      ownerEpoch: 1,
      providerId: "test-provider",
      profileId: "test-profile",
      preparationKey: PREPARATION_KEY,
      nodeDeviceId: "node-1",
      leaseId: "lease-1",
      bundleHash: BUNDLE_HASH,
      assertCurrent,
    };
  }
  function expiry() {
    return environments.requestPreparedDestroy({
      environmentId: "prepared-1",
      ownerEpoch: 1,
      preparationKey: PREPARATION_KEY,
      reason: "expired",
      assertCurrent,
    });
  }

  function build(environmentId = "build-1", key = PREPARATION_KEY, maxTotal = 1) {
    const input = intent(environmentId, key);
    return environments.ensurePreparedIntent({
      intent: { ...input, preparation: { ...input.preparation, purpose: "build" } },
      projectKey: PROJECT_KEY,
      target: 0,
      maxTotal,
      assertCurrent,
    });
  }

  it("admits a build at zero ready target and preserves its purpose on reopen", async () => {
    expect((await build())?.preparation?.purpose).toBe("build");
    expect(
      environments.isPreparedIntentWithinCapacity({
        environmentId: "build-1",
        target: 0,
        maxTotal: 1,
      }),
    ).toBe(true);
    await reopenStores();
    expect(environments.get("build-1")?.preparation?.purpose).toBe("build");
    expect(await build("build-2")).toEqual(environments.get("build-1"));
    expect(environments.list()).toHaveLength(1);
  });

  it("counts unfinished builds and unresolved teardown against global capacity", async () => {
    const original = (await build())!;
    expect(await build("disabled", PREPARATION_KEY, 0)).toBeUndefined();
    expect(await build("other-key", "e".repeat(64))).toBeUndefined();
    await environments.requestDestroy({
      environmentId: original.environmentId,
      state: original.state,
    });
    expect(await build("retry")).toBeUndefined();
    await environments.transition({
      environmentId: original.environmentId,
      from: "requested",
      to: "failed",
    });
    expect((await build("retry"))?.environmentId).toBe("retry");
  });

  it("adds the purpose column to legacy rows without changing their reserve lifecycle", async () => {
    const original = (await reserve())!;
    database.db.exec("ALTER TABLE worker_environments DROP COLUMN preparation_purpose");
    await reopenStores();
    expect(environments.get(original.environmentId)).toEqual(original);
    expect(
      database.db.prepare("SELECT preparation_purpose FROM worker_environments").get(),
    ).toEqual({ preparation_purpose: null });
    expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    await reopenStores();
    expect(environments.get(original.environmentId)?.preparation?.purpose).toBe("reserve");
  });

  it("assigns once without caller-thread SQL and retains consumption after placement deletion and reopen", async () => {
    await ready();
    const first = await selection();
    const second = await selection("session-2");
    const queries = observeMainThreadSql();
    let assigned: Awaited<ReturnType<typeof placements.bindPreparedEnvironment>>;
    try {
      assigned = await placements.bindPreparedEnvironment(first);
      queries.expectIdle();
    } finally {
      queries.restore();
    }
    expect(assigned).toBeDefined();
    expect(assigned).toMatchObject({ state: "provisioning", environmentId: "prepared-1" });
    const anotherStore = createWorkerSessionPlacementStore({ database, now: () => nowMs });
    expect(await anotherStore.bindPreparedEnvironment(second)).toBeUndefined();
    const failed = await placements.fail({
      sessionId: first.sessionId,
      expectedGeneration: assigned!.generation,
      recoveryError: "assignment cancelled",
    });
    placements.retireSessionPlacement({
      sessionId: first.sessionId,
      expectedState: "failed",
      expectedGeneration: failed.generation,
    });
    await reopenStores();
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBe(1_000);
    expect(await placements.bindPreparedEnvironment(second)).toBeUndefined();
    expect(placements.get(second.sessionId)?.state).toBe("requested");
  });

  it.each(["claim-first", "expire-first"] as const)(
    "excludes claim and expiry in %s order",
    async (order) => {
      await ready();
      const request = await selection();
      if (order === "claim-first") {
        expect((await placements.bindPreparedEnvironment(request))?.state).toBe("provisioning");
        nowMs = 2_000;
        expect(await expiry()).toBeUndefined();
        expect(environments.get("prepared-1")?.destroyRequestedAtMs).toBeNull();
      } else {
        nowMs = 2_000;
        expect((await expiry())?.destroyRequestedAtMs).toBe(2_000);
        expect(await placements.bindPreparedEnvironment(request)).toBeUndefined();
        expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
      }
    },
  );

  it("keeps old generations and uncertain cleanup inside capacity across providers", async () => {
    const providerId = "replacement-provider";
    await reserve();
    expect(await reserve("prepared-2", "e".repeat(64), 4, providerId)).toBeUndefined();
    expect(
      (
        await environments.requestPreparedDestroy({
          environmentId: "prepared-1",
          ownerEpoch: 0,
          preparationKey: PREPARATION_KEY,
          reason: "invalidated",
          assertCurrent,
        })
      )?.destroyRequestedAtMs,
    ).toBe(1_000);
    expect(await reserve("prepared-2", "e".repeat(64), 4, providerId)).toBeUndefined();
    await environments.transition({
      environmentId: "prepared-1",
      from: "requested",
      to: "failed",
    });
    expect((await reserve("prepared-2", "e".repeat(64), 4, providerId))?.state).toBe("requested");
  });

  it("counts consumed workers awaiting cleanup against the reserve cap across providers", async () => {
    await ready();
    await placements.bindPreparedEnvironment(await selection());
    await environments.requestDestroy({ environmentId: "prepared-1", state: "ready" });
    expect(await reserve("prepared-2", PREPARATION_KEY, 4, "replacement-provider")).toBeUndefined();
  });

  it("enforces the global cap, zero capacity, expiry and immutable intent replay", async () => {
    expect(await reserve("disabled", PREPARATION_KEY, 0)).toBeUndefined();
    const original = await reserve();
    expect(await reserve()).toEqual(original);
    await expect(reserve("prepared-1", "e".repeat(64))).rejects.toThrow("identity changed");
    expect(
      await environments.ensurePreparedIntent({
        intent: { ...intent("other"), profileId: "other-profile" },
        projectKey: PROJECT_KEY,
        target: 1,
        maxTotal: 1,
        assertCurrent,
      }),
    ).toBeUndefined();
    nowMs = 2_000;
    expect(await reserve("expired", PREPARATION_KEY, 4)).toBeUndefined();
  });

  it.each([
    { ownerEpoch: 2 },
    { preparationKey: "e".repeat(64) },
    { leaseId: "replacement" },
    { nodeDeviceId: "replacement" },
    { bundleHash: "e".repeat(64) },
    { profileId: "other" },
    { sessionKey: "agent:main:other" },
    { expectedGeneration: 999 },
  ])("rejects stale selection without consuming capacity: %j", async (changed) => {
    await ready();
    const request = await selection();
    expect(await placements.bindPreparedEnvironment({ ...request, ...changed })).toBeUndefined();
    expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
    expect(placements.get(request.sessionId)?.state).toBe("requested");
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back prepared consumption and assignment when authority closes at %s admission",
    async (stage) => {
      await ready();
      const request = await selection();
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      let revoked = false;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementationOnce((admit, attachment) =>
          createAdmission((current, grant) => {
            if (current.stage === stage) {
              revoked = true;
            }
            admit(current, grant);
          }, attachment),
        );
      try {
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
      } finally {
        admission.mockRestore();
      }
      expect(environments.get("prepared-1")?.preparation?.consumedAtMs).toBeNull();
      expect(placements.get(request.sessionId)?.state).toBe("requested");
    },
  );

  it("requires the exact reservation after expiry and reopen and cannot recycle its rollback", async () => {
    await ready();
    const request = await selection();
    const assigned = (await placements.bindPreparedEnvironment(request))!;
    nowMs = 2_001;
    await reopenStores();
    const syncing = await placements.transition({
      sessionId: request.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: assigned!.generation,
      patch: { workerBundleHash: BUNDLE_HASH },
    });
    const attach = {
      environmentId: "prepared-1",
      from: "ready" as const,
      to: "attached" as const,
      expectedOwnerEpoch: 1,
      patch: {
        attachedSessionIds: [request.sessionId],
        credential: {
          credentialHash: hashWorkerCredential("attached-credential"),
          sessionId: request.sessionId,
          rpcSetVersion: 1,
          expiresAtMs: 10_000,
        },
      },
    };
    await expect(environments.transition(attach)).rejects.toThrow("exact placement reservation");
    const binding = { ...request, generation: syncing.generation };
    await expect(
      environments.transition({ ...attach, placementBinding: { ...binding, generation: 0 } }),
    ).rejects.toThrow("exact placement reservation");
    const attached = await environments.transition({ ...attach, placementBinding: binding });
    expect(attached.state).toBe("attached");
    const idle = await environments.transition({
      environmentId: "prepared-1",
      from: "attached",
      to: "idle",
    });
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
