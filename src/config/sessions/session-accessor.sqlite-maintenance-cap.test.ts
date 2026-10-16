import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import { applySessionEntryMaintenance } from "./session-accessor.sqlite-maintenance.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
  observeNextPeriodicMaintenance,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createCapBatchStore(protectedOnly = false) {
  const fixture = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-cap-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs: 86_400_000,
    workerMaintenance: true,
    maintenanceScopes: [],
  });
  fixture.request.maintenanceConfig.maxEntries = 100;
  vi.useRealTimers();
  const keys = Array.from({ length: 179 }, (_, index) => `agent:main:cap-batch-${index}`);
  runOpenClawAgentWriteTransaction((database) => {
    if (protectedOnly) {
      writeSessionEntry(database, sessionKey, {
        sessionId: "age-kick",
        updatedAt: fixture.updatedAt,
        modelSelectionLocked: true,
      });
    }
    keys.forEach((key, index) => {
      writeSessionEntry(database, key, {
        sessionId: `cap-batch-${index}`,
        ...(protectedOnly ? { modelSelectionLocked: true } : {}),
        updatedAt: fixture.updatedAt - keys.length + index,
      });
    });
  }, fixture.scope);
  const plans: SessionEntryMaintenancePlan[] = [];
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      plans.push(result.value);
    }
    return result;
  });
  return { ...fixture, keys, plans };
}

it.for(["automatic", "inline", "protected"] as const)(
  "bounds cap work and finishes eligible capacity maintenance (%s)",
  async (owner, { signal }) => {
    const { request, scope, storePath, keys, plans } = createCapBatchStore(owner === "protected");
    if (owner === "inline") {
      plans.push(
        runOpenClawAgentWriteTransaction(
          (database) =>
            applySessionEntryMaintenance(database, {
              activeSessionKey: sessionKey,
              archiveDirectory: request.archiveDirectory,
              forceMaintenance: true,
              maintenanceConfig: request.maintenanceConfig,
              preservation: () => ({
                providerKeys: [],
                workIdentities: [],
                lifecycleIdentities: [],
              }),
              storePath,
            }),
          scope,
        ),
      );
    } else {
      const scheduled = observeNextPeriodicMaintenance();
      kickSessionEntryMaintenanceAfterWrite(request);
      await scheduled(signal);
    }
    // The first automatic batch leaves 116 entries, below high-water 125 but above cap 100.
    expect(plans.filter((plan) => plan.capArchived > 0).map((plan) => plan.capArchived)).toEqual(
      owner === "protected" ? [] : owner === "inline" ? [80] : [64, 16],
    );
    const archived = keys.filter(
      (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
    );
    expect(archived).toEqual(owner === "protected" ? [] : keys.slice(0, 80));
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(plans.flatMap((plan) => plan.archivedEntries.map((entry) => entry.sessionKey))).toEqual(
      archived,
    );
  },
);

it.for(["victim", "remaining"] as const)(
  "releases the cap writer between batches and honors new protection (%s)",
  async (protection, { signal }) => {
    const { request, storePath, keys, plans } = createCapBatchStore();
    const protectedKey = keys[64]!;
    let protectedKeys: string[] = [];
    const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => protectedKeys,
      dispose() {},
    }));
    let commits = 0;
    let releases = 0;
    let foreground: Promise<unknown> | undefined;
    let foregroundCompleted = false;
    observeSessionMaintenancePlanningWorker({
      afterExecute(result) {
        if (result.kind === "committed" && ++commits === 1) {
          // Queue under the first operation; await only after its FIFO custody is released.
          foreground = patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({ label: "foreground between cap batches" }),
            { skipMaintenance: true },
          ).then(() => {
            foregroundCompleted = true;
          });
        }
      },
      async afterRelease() {
        if (++releases === 1) {
          protectedKeys =
            protection === "remaining" ? [sessionKey, ...keys.slice(64)] : [protectedKey];
          await withinTest(foreground!, signal);
        }
      },
      beforeExecute() {
        if (commits > 0) {
          expect(foregroundCompleted).toBe(true);
        }
      },
    });
    try {
      const scheduled = observeNextPeriodicMaintenance();
      kickSessionEntryMaintenanceAfterWrite(request);
      await scheduled(signal);
      expect(plans.filter((plan) => plan.capArchived > 0).map((plan) => plan.capArchived)).toEqual(
        protection === "remaining" ? [64] : [64, 16],
      );
      if (protection === "remaining") {
        expect(plans.at(-1)).toMatchObject({ capped: 0, archived: 0, entryRemovals: [] });
      }
      expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(
        "foreground between cap batches",
      );
      expect(loadSessionEntry({ storePath, sessionKey: protectedKey })?.archivedAt).toBeUndefined();
      const archived = keys.filter(
        (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
      );
      expect(archived).toEqual(
        protection === "remaining"
          ? keys.slice(0, 64)
          : keys.slice(0, 81).filter((key) => key !== protectedKey),
      );
    } finally {
      unregister();
    }
  },
);

it("keeps the first cap receipt and stops later batches when maintenance authority retires", async ({
  signal,
}) => {
  const { database, request, storePath, keys, plans } = createCapBatchStore();
  const retired = createDeferred();
  let releases = 0;
  observeSessionMaintenancePlanningWorker({
    afterRelease() {
      if (++releases === 1) {
        markGatewayRestartDraining();
        retired.resolve();
      }
    },
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(retired.promise, signal);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  expect(plans.map((plan) => plan.capArchived)).toEqual([64]);
  const archived = keys.filter(
    (key) => loadSessionEntry({ storePath, sessionKey: key })?.archivedAt,
  );
  expect(archived).toEqual(keys.slice(0, 64));
});
