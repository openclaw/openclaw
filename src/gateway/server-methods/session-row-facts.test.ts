import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.js";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../../config/sessions/activity-summary.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { withSessionHistoryWorkerDatabase } from "../../config/sessions/session-transcript-worker-runtime.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabaseReadOnly from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as activitySummary from "../session-activity-summary-state.js";
import { beginSessionPermissionChange } from "../session-permission-change.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { createSessionRowPlacementProjection } from "../session-row-placement-projection.js";
import * as rowMaterialization from "../session-row-projection-materialize.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { listProjectedSessions } from "../session-utils-list.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import type { GatewayNodeWorkerBundleInstallObservation } from "../worker-environments/node-worker-bundle-installer.js";
import {
  createWorkerPlacementRunnerAvailabilityReader,
  createWorkerPlacementRuntimeInstallReader,
} from "../worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { readSessionRowFacts } from "./session-placement-read-projection.js";

afterEach(() => vi.restoreAllMocks());

const createProjectionConfig = () => ({
  agents: {
    entries: { main: {} },
    defaults: { model: "unit-test/model", utilityModel: "" },
  },
});
const sessionIdentity = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${sessionId}`,
  sessionId,
});

it("prepares current placement facts off the host thread and retries failed refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = createProjectionConfig();
    setRuntimeConfigSnapshot(cfg);
    const identity = sessionIdentity("placement-read");
    replaceSessionEntrySync(identity, { sessionId: " placement-read ", updatedAt: 1 });
    expect(loadSessionEntryReadOnly(identity)?.sessionId).toBe(" placement-read ");
    const placements = createWorkerSessionPlacementStore();
    await placements.startDispatch(identity);
    const projection = await createSessionRowProjection({
      cfg,
      modelCatalog: [],
      placementFactsReader: placements,
    });
    const change = { agentId: identity.agentId, sessionKey: identity.sessionKey };
    const currentPlacement = () =>
      projection.snapshot({ agentId: identity.agentId, key: identity.sessionKey }).row?.placement;
    const refresh = async () => {
      const reads = vi.spyOn(stateDatabase, "openOpenClawStateDatabase");
      const statements = observeSqliteReadSql(StatementSync.prototype);
      try {
        sessionChanges.emit(change);
        await projection.ensureMaterialized();
        const result = currentPlacement();
        expect(reads).not.toHaveBeenCalled();
        expect(
          statements.queries.filter((sql) => /\bfrom\s+"?worker_session_placements\b/i.test(sql)),
        ).toEqual([]);
        return result;
      } finally {
        reads.mockRestore();
        statements.restore();
      }
    };
    try {
      await projection.ensureMaterialized();
      expect(await refresh()).toMatchObject({ state: "requested" });
      await placements.fail({ sessionId: identity.sessionId, recoveryError: "Current failure" });
      expect(await refresh()).toMatchObject({ state: "failed" });
      const refused = vi
        .spyOn(placements, "readProjection")
        .mockRejectedValue(new Error("Placement store admission refused"));
      try {
        sessionChanges.emit(change);
        await expect(projection.ensureMaterialized()).rejects.toThrow(
          "Placement store admission refused",
        );
      } finally {
        refused.mockRestore();
      }
      expect(await refresh()).toMatchObject({ state: "failed" });
      const captured = createDeferredCore();
      const releaseRead = createDeferredCore();
      const readProjection = placements.readProjection.bind(placements);
      const delayed = vi.spyOn(placements, "readProjection").mockImplementationOnce(async (ids) => {
        const snapshot = await readProjection(ids);
        captured.resolve();
        await releaseRead.promise;
        return snapshot;
      });
      try {
        sessionChanges.emit(change);
        const refreshed = projection.ensureMaterialized();
        await captured.promise;
        await placements.fail({
          sessionId: identity.sessionId,
          recoveryError: "Changed during preparation",
        });
        sessionChanges.emit(change);
        releaseRead.resolve();
        await refreshed;
        expect(currentPlacement()).toMatchObject({ recoveryError: "Changed during preparation" });
      } finally {
        releaseRead.resolve();
        delayed.mockRestore();
      }
    } finally {
      projection.dispose();
    }
  });
});

it("refreshes selected placement/environment facts by revision and reuses them without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const identity = sessionIdentity("row-facts");
    replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt: 1 });
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const environmentStore = await createWorkerEnvironmentStore({ database });
    const environmentIdentity = {
      environmentId: "row-environment",
      ownerEpoch: 7,
    };
    seedAttachedPlacementEnvironment(database, {
      ...environmentIdentity,
      sessionId: identity.sessionId,
      providerId: DEVICE_WORKER_PROVIDER_ID,
      profileId: "desktop",
      nodeDeviceId: "row-device",
    });
    let placement = await placements.startDispatch(identity);
    placement = await placements.transition({
      sessionId: identity.sessionId,
      from: placement.state,
      expectedGeneration: placement.generation,
      to: "provisioning",
      patch: { environmentId: "row-environment" },
    });
    let machine = { cpu: 4, memoryGb: 16 };
    let startStatus: WorkerEnvironmentStartStatus | undefined = { mode: "snapshot" };
    const environments = {
      get(environmentId: string) {
        const record = environmentStore.get(environmentId);
        return record
          ? {
              ...record,
              desktopAvailable: false,
              desktopApps: [],
              tunnelStatus: "stopped" as const,
              startStatus,
            }
          : undefined;
      },
      readMachineShape: () => machine,
    };
    let runnerAvailable = true;
    let disk = {
      status: "ok" as const,
      availableBytes: 6_000,
      totalBytes: 10_000,
      observedAtMs: 10,
    };
    let runtimeInstall: GatewayNodeWorkerBundleInstallObservation = {
      nodeId: "row-device",
      environmentIds: [placement.environmentId!],
      bundleHash: "c".repeat(64),
      phase: "transferring",
      transferredBytes: 100,
      totalBytes: 1_000,
      startedAtMs: 10,
      updatedAtMs: 11,
    };
    let runtimeInstallVersion = 0;
    const context = {
      workerSessionPlacementService: placements,
      workerEnvironmentService: environments,
      workerPlacementDiskSpaceReader: { read: () => disk, version: () => disk.observedAtMs },
      workerPlacementRunnerAvailabilityReader: createWorkerPlacementRunnerAvailabilityReader({
        environments,
        hasCurrentDeviceRunner: () => runnerAvailable,
      }),
      workerPlacementRuntimeInstallReader: createWorkerPlacementRuntimeInstallReader({
        environments,
        installer: {
          readInstall: (nodeId) => (nodeId === runtimeInstall.nodeId ? runtimeInstall : undefined),
          readInstallForEnvironment: (id) =>
            runtimeInstall.environmentIds.includes(id) ? runtimeInstall : undefined,
          version: () => runtimeInstallVersion,
        },
      }),
    };
    const preparedPlacements = createSessionRowPlacementProjection(placements, () => undefined);
    const refreshPlacements = async () => {
      preparedPlacements.invalidate();
      await preparedPlacements.prepare();
    };
    preparedPlacements.register(identity.sessionId);
    await preparedPlacements.prepare();
    const facts = readSessionRowFacts({
      cfg: {},
      target: {
        key: identity.sessionKey,
        agentId: identity.agentId,
        storeTarget: {
          agentId: "main",
          storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
        },
      },
      entry: loadSessionEntryReadOnly(identity)!,
      context,
      placementFactsReader: preparedPlacements,
      databaseFacts: { hasBoard: false },
    });
    const starting = facts.present();
    expect(facts.present()).toBe(starting);
    expect(starting.placement).toMatchObject({
      state: "provisioning",
      startStatus: { mode: "snapshot" },
    });
    startStatus = { mode: "snapshot", phase: "saving" };
    expect(facts.present().placement).toMatchObject({ startStatus });
    expect(starting.placement).not.toHaveProperty("startStatus.phase");
    startStatus = undefined;
    expect(facts.present().placement).not.toHaveProperty("startStatus");
    for (const step of [
      { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
      {
        to: "starting",
        patch: {
          workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
          remoteWorkspaceDir: "/workspace",
        },
      },
      { to: "active", patch: { activeOwnerEpoch: 7 } },
    ] as const) {
      placement = await placements.transition({
        sessionId: identity.sessionId,
        from: placement.state,
        expectedGeneration: placement.generation,
        ...step,
      });
    }
    await refreshPlacements();
    const reads = observeMainThreadReads();
    const finishPermissionChange = beginSessionPermissionChange(identity.sessionId);
    try {
      const first = facts.present();
      expect(facts.present()).toBe(first);
      expect(Object.isFrozen(first.placement)).toBe(true);
      expect(first.permissionModePending).toBe(true);
      expect(first.placement).toMatchObject({
        state: "active",
        machine: { cpu: 4, memoryGb: 16 },
        diskSpace: { status: "ok", availableBytes: 6_000 },
        runner: { status: "available", deviceId: "row-device" },
        workerRuntimeInstall: { phase: "transferring", transferredBytes: 100 },
      });
      expect(first.placement).not.toHaveProperty("workerRuntimeInstall.bundleHash");
      disk = { ...disk, availableBytes: 5_000, observedAtMs: 11 };
      expect(facts.present().placement).toMatchObject({
        diskSpace: { availableBytes: 5_000, observedAtMs: 11 },
      });
      runnerAvailable = false;
      context.workerPlacementRunnerAvailabilityReader.markChanged();
      expect(facts.present().placement).toMatchObject({ runner: { status: "offline" } });
      runtimeInstall = {
        ...runtimeInstall,
        phase: "installing",
        transferredBytes: 1_000,
        updatedAtMs: 12,
      };
      runtimeInstallVersion++;
      const updated = facts.present();
      expect(facts.present()).toBe(updated);
      expect(updated.placement).toMatchObject({
        diskSpace: { status: "ok", availableBytes: 5_000, observedAtMs: 11 },
        runner: { status: "offline" },
        workerRuntimeInstall: { phase: "installing", transferredBytes: 1_000, updatedAtMs: 12 },
      });
      expect(first.placement).toHaveProperty("workerRuntimeInstall.transferredBytes", 100);
      expect(first.placement).toMatchObject({ diskSpace: { availableBytes: 6_000 } });
      finishPermissionChange();
      expect(facts.present().permissionModePending).toBe(false);
      reads.expectIdle();

      const rowReads = vi.spyOn(agentDatabaseReadOnly, "withOpenClawAgentDatabaseReadOnly");
      const summaryReads = vi.spyOn(activitySummary, "projectSessionActivitySummary");
      machine = { cpu: 8, memoryGb: 32 };
      seedAttachedPlacementEnvironment(database, {
        ...environmentIdentity,
        sessionId: identity.sessionId,
        nodeDeviceId: "replacement-device",
      });
      await refreshPlacements();
      expect(facts.present().placement).toMatchObject({
        state: "active",
        machine: { cpu: 8, memoryGb: 32 },
        runner: { status: "offline", deviceId: "replacement-device" },
      });
      expect(facts.present().placement).not.toHaveProperty("workerRuntimeInstall");
      const move = await placements.beginPlacementMove({
        sessionId: identity.sessionId,
        source: {
          generation: placement.generation,
          ...environmentIdentity,
        },
        target: { kind: "gateway" },
      });
      await refreshPlacements();
      expect(facts.present()).toMatchObject({
        placement: { state: "draining" },
        placementMove: { target: { kind: "gateway" } },
      });
      const reconciling = await placements.startReconcile({
        ...environmentIdentity,
        sessionId: identity.sessionId,
        expectedGeneration: move.placement.generation,
      });
      await placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "Worker stopped",
      });
      await refreshPlacements();
      expect(facts.present().placement).toMatchObject({
        state: "failed",
        recoveryAction: "stop-first",
      });
      expect(rowReads).not.toHaveBeenCalled();
      expect(summaryReads).not.toHaveBeenCalled();
      const release = retainSessionListForegroundWork();
      const cfg = createProjectionConfig();
      setRuntimeConfigSnapshot(cfg);
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        context,
        placementFactsReader: placements,
      });
      const list = async () =>
        (await listProjectedSessions({ projection, opts: { agentId: "main" } })).sessions[0];
      try {
        expect((await list())?.placement).toMatchObject({
          state: "failed",
          recoveryAction: "stop-first",
        });
        rowReads.mockClear();
        summaryReads.mockClear();
        const entryReads = vi.spyOn(rowMaterialization, "readSessionRowEntry");
        try {
          expect(
            await placements.recordPlacementMoveError({
              operationId: move.intent.operationId,
              sessionId: identity.sessionId,
              error: "Current move failure",
            }),
          ).toBe(true);
          expect((await list())?.placementMove).toMatchObject({ error: "Current move failure" });
          expect(entryReads).not.toHaveBeenCalled();
          for (const [from, to] of [
            ["attached", "draining"],
            ["draining", "destroying"],
            ["destroying", "destroyed"],
          ] as const) {
            await environmentStore.transition({ environmentId: "row-environment", from, to });
          }

          expect((await list())?.placement).toMatchObject({
            state: "failed",
            recoveryAction: "restart",
          });
          expect(entryReads).not.toHaveBeenCalled();
        } finally {
          entryReads.mockRestore();
        }
      } finally {
        projection.dispose();
        release();
      }
      await refreshPlacements();
      expect(facts.present().placement).toMatchObject({
        state: "failed",
        recoveryAction: "restart",
      });
      expect(rowReads).not.toHaveBeenCalled();
      expect(summaryReads).not.toHaveBeenCalled();
      reads.clear();
      facts.present();
      facts.present();
      reads.expectIdle();
    } finally {
      preparedPlacements.dispose();
      finishPermissionChange();
      reads.restore();
    }
  });
});

it("prepares board membership and recap freshness from the physical target and reuses them without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        defaults: { utilityModel: "test/utility" },
        entries: { main: {}, work: {} },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const storePath = openOpenClawAgentDatabase({ agentId: "main" }).path;
    const otherPath = openOpenClawAgentDatabase({ agentId: "other" }).path;
    const scope = { agentId: "main", sessionKey: "global", sessionId: "row-recap", storePath };
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      activitySummary: {
        version: 1,
        formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
        text: "Prepared recap.",
        updatedAt: 1,
        sessionId: scope.sessionId,
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
    });
    replaceSessionEntrySync(
      { agentId: "other", sessionKey: "global", storePath: otherPath },
      { sessionId: "other-row", updatedAt: 1 },
    );
    const board = new SqliteBoardStore({
      resolveSession: () => ({ agentId: "main", path: storePath, sessionKey: "global" }),
    });
    await board.applyOps({ sessionKey: "global" }, [
      { kind: "tab_create", tabId: "main", title: "Main" },
    ]);
    const target = { key: "global", agentId: "work", storeTarget: { agentId: "main", storePath } };
    const entry = loadSessionEntryReadOnly(scope)!;
    const prepareDatabaseFacts = (agentId: string, path: string) =>
      withSessionHistoryWorkerDatabase({ agentId, path }, async (reader) => {
        const result = await reader.readRowFacts({ env: process.env, sessionKeys: [target.key] });
        return result.rows[0]!;
      });
    const databaseFacts = await prepareDatabaseFacts("main", storePath);
    const otherDatabaseFacts = await prepareDatabaseFacts("other", otherPath);
    const membershipReads = observeSqliteReadSql(StatementSync.prototype);
    const facts = readSessionRowFacts({ cfg, target, entry, databaseFacts });
    membershipReads.restore();
    expect(membershipReads.queries.filter((sql) => /from "board_tabs"/iu.test(sql))).toEqual([]);
    expect(facts.hasBoard).toBe(true);
    expect(
      readSessionRowFacts({
        cfg,
        target: { ...target, storeTarget: { agentId: "other", storePath: otherPath } },
        entry: { sessionId: "other-row", updatedAt: 1 },
        databaseFacts: otherDatabaseFacts,
      }).hasBoard,
    ).toBe(false);
    const reads = observeMainThreadReads();
    try {
      const expected = { text: "Prepared recap.", updatedAt: 1, state: "current" };
      expect(facts.present().activitySummary).toEqual(expected);
      expect(facts.present().activitySummary).toEqual(expected);
      reads.expectIdle();
    } finally {
      reads.restore();
    }
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "new-message",
          parentId: null,
          message: { role: "user", content: "New activity", timestamp: Date.now() },
        },
      ],
      touchSessionEntry: false,
    });
    await board.applyOps({ sessionKey: "global" }, [{ kind: "tab_delete", tabId: "main" }]);
    const refreshed = readSessionRowFacts({
      cfg,
      target,
      entry,
      databaseFacts: await prepareDatabaseFacts("main", storePath),
    });
    expect(refreshed.hasBoard).toBe(false);
    expect(refreshed.present().activitySummary?.state).toBe("stale");
  });
});
