import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as agentDatabaseReadOnly from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as activitySummary from "../session-activity-summary-state.js";
import { beginSessionPermissionChange } from "../session-permission-change.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { createSessionRowPlacementProjection } from "../session-row-placement-projection.js";
import * as rowMaterialization from "../session-row-projection-materialize.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { listProjectedSessions } from "../session-utils-list.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "../worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { readSessionRowFacts } from "./session-placement-read-projection.js";

afterEach(() => vi.restoreAllMocks());

it("prepares current placement facts off the host thread and retries failed refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:placement-read",
      sessionId: "placement-read",
    };
    replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt: 1 });
    const placements = createWorkerSessionPlacementStore();
    placements.startDispatch(identity);
    const options = {
      cfg: {
        agents: {
          list: [{ id: "main", default: true }],
          defaults: { model: "unit-test/model", utilityModel: "" },
        },
      },
      modelCatalog: [],
      placementFactsReader: placements,
    };
    const projection = await createSessionRowProjection(options);
    const refresh = async () => {
      const reads = vi.spyOn(stateDatabase, "openOpenClawStateDatabase");
      let placementReads = 0;
      const statements = (["get", "all", "iterate"] as const).map((method) => {
        const execute = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
          this: StatementSync,
          ...args: unknown[]
        ) {
          if (/\bfrom\s+"?worker_session_placements\b/i.test(this.sourceSQL)) {
            placementReads++;
          }
          return Reflect.apply(execute, this, args);
        });
      });
      try {
        sessionChanges.emit({ agentId: identity.agentId, sessionKey: identity.sessionKey });
        await projection.ensureMaterialized();
        const result = projection.snapshot({ agentId: identity.agentId, key: identity.sessionKey });
        expect(reads).not.toHaveBeenCalled();
        expect(placementReads).toBe(0);
        return result.row?.placement;
      } finally {
        reads.mockRestore();
        for (const statement of statements) {
          statement.mockRestore();
        }
      }
    };
    try {
      await projection.ensureMaterialized();
      expect(await refresh()).toMatchObject({ state: "requested" });
      placements.fail({ sessionId: identity.sessionId, recoveryError: "Current failure" });
      expect(await refresh()).toMatchObject({ state: "failed" });
      const refused = vi
        .spyOn(placements, "readProjection")
        .mockRejectedValue(new Error("Placement store admission refused"));
      try {
        sessionChanges.emit({ agentId: identity.agentId, sessionKey: identity.sessionKey });
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
        sessionChanges.emit({ agentId: identity.agentId, sessionKey: identity.sessionKey });
        const refreshed = projection.ensureMaterialized();
        await captured.promise;
        placements.fail({
          sessionId: identity.sessionId,
          recoveryError: "Changed during preparation",
        });
        sessionChanges.emit({ agentId: identity.agentId, sessionKey: identity.sessionKey });
        releaseRead.resolve();
        await refreshed;
        expect(
          projection.snapshot({ agentId: identity.agentId, key: identity.sessionKey }).row
            ?.placement,
        ).toMatchObject({ recoveryError: "Changed during preparation" });
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
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:row-facts",
      sessionId: "row-facts",
    };
    replaceSessionEntrySync(identity, { sessionId: identity.sessionId, updatedAt: 1 });
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const environmentStore = createWorkerEnvironmentStore({ database });
    seedAttachedPlacementEnvironment(database, {
      environmentId: "row-environment",
      sessionId: identity.sessionId,
      ownerEpoch: 7,
      providerId: DEVICE_WORKER_PROVIDER_ID,
      profileId: "desktop",
      nodeDeviceId: "row-device",
    });
    let placement = placements.startDispatch(identity);
    for (const step of [
      { to: "provisioning", patch: { environmentId: "row-environment" } },
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
      placement = placements.transition({
        sessionId: identity.sessionId,
        from: placement.state,
        expectedGeneration: placement.generation,
        ...step,
      });
    }
    let machine = { cpu: 4, memoryGb: 16 };
    const environments = {
      get(environmentId: string) {
        const record = environmentStore.get(environmentId);
        return record
          ? {
              ...record,
              desktopAvailable: false,
              desktopApps: [],
              tunnelStatus: "stopped" as const,
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
    const context = {
      workerSessionPlacementService: placements,
      workerEnvironmentService: environments,
      workerPlacementDiskSpaceReader: { read: () => disk, version: () => 0 },
      workerPlacementRunnerAvailabilityReader: createWorkerPlacementRunnerAvailabilityReader({
        environments,
        hasCurrentDeviceRunner: () => runnerAvailable,
      }),
    };
    const preparedPlacements = createSessionRowPlacementProjection(placements);
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
    });
    const reads = (["all", "get", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    const finishPermissionChange = beginSessionPermissionChange(identity.sessionId);
    try {
      const first = facts.present();
      expect(first.permissionModePending).toBe(true);
      expect(first.placement).toMatchObject({
        state: "active",
        providerId: DEVICE_WORKER_PROVIDER_ID,
        profileId: "desktop",
        machine: { cpu: 4, memoryGb: 16 },
        diskSpace: { status: "ok", availableBytes: 6_000 },
        runner: { status: "available", deviceId: "row-device" },
      });
      disk = { ...disk, availableBytes: 5_000, observedAtMs: 11 };
      runnerAvailable = false;
      expect(facts.present().placement).toMatchObject({
        diskSpace: { status: "ok", availableBytes: 5_000, observedAtMs: 11 },
        runner: { status: "offline" },
      });
      expect(first.placement).toMatchObject({ diskSpace: { availableBytes: 6_000 } });
      finishPermissionChange();
      expect(facts.present().permissionModePending).toBe(false);
      for (const read of reads) {
        expect(read).not.toHaveBeenCalled();
      }

      const placementReads = vi.spyOn(placements, "readProjection");
      const rowReads = vi.spyOn(agentDatabaseReadOnly, "withOpenClawAgentDatabaseReadOnly");
      const summaryReads = vi.spyOn(activitySummary, "projectSessionActivitySummary");
      machine = { cpu: 8, memoryGb: 32 };
      seedAttachedPlacementEnvironment(database, {
        environmentId: "row-environment",
        sessionId: identity.sessionId,
        ownerEpoch: 7,
        nodeDeviceId: "replacement-device",
      });
      expect(placementReads).not.toHaveBeenCalled();
      preparedPlacements.invalidate();
      await preparedPlacements.prepare();
      expect(facts.present().placement).toMatchObject({
        state: "active",
        machine: { cpu: 8, memoryGb: 32 },
        runner: { status: "offline", deviceId: "replacement-device" },
      });
      expect(placementReads).toHaveBeenCalledTimes(1);
      const move = placements.beginPlacementMove({
        sessionId: identity.sessionId,
        source: {
          generation: placement.generation,
          environmentId: "row-environment",
          ownerEpoch: 7,
        },
        target: { kind: "gateway" },
      });
      preparedPlacements.invalidate();
      await preparedPlacements.prepare();
      expect(facts.present()).toMatchObject({
        placement: { state: "draining" },
        placementMove: { target: { kind: "gateway" } },
      });
      const reconciling = placements.startReconcile({
        sessionId: identity.sessionId,
        environmentId: "row-environment",
        ownerEpoch: 7,
        expectedGeneration: move.placement.generation,
      });
      placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "Worker stopped",
      });
      preparedPlacements.invalidate();
      await preparedPlacements.prepare();
      expect(facts.present().placement).toMatchObject({
        state: "failed",
        recoveryAction: "stop-first",
      });
      expect(rowReads).not.toHaveBeenCalled();
      expect(summaryReads).not.toHaveBeenCalled();
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg: {
          agents: {
            list: [{ id: "main", default: true }],
            defaults: { model: "unit-test/model", utilityModel: "" },
          },
        },
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
            placements.recordPlacementMoveError({
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
            environmentStore.transition({ environmentId: "row-environment", from, to });
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
      preparedPlacements.invalidate();
      await preparedPlacements.prepare();
      expect(facts.present().placement).toMatchObject({
        state: "failed",
        recoveryAction: "restart",
      });
      expect(rowReads).not.toHaveBeenCalled();
      expect(summaryReads).not.toHaveBeenCalled();
      for (const read of reads) {
        read.mockClear();
      }
      facts.present();
      facts.present();
      for (const read of reads) {
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      preparedPlacements.dispose();
      finishPermissionChange();
      for (const read of reads) {
        read.mockRestore();
      }
    }
  });
});

it("prepares board membership and recap freshness from the physical target and reuses them without SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: {
        defaults: { utilityModel: "test/utility" },
        list: [{ id: "main" }, { id: "work" }],
      },
    };
    const storePath = openOpenClawAgentDatabase({ agentId: "main" }).path;
    const otherPath = openOpenClawAgentDatabase({ agentId: "other" }).path;
    const scope = { agentId: "main", sessionKey: "global", sessionId: "row-recap", storePath };
    replaceSessionEntrySync(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      activitySummary: {
        version: 1,
        formatRevision: 2,
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
    const facts = readSessionRowFacts({ cfg, target, entry });
    expect(facts.hasBoard).toBe(true);
    expect(
      readSessionRowFacts({
        cfg,
        target: { ...target, storeTarget: { agentId: "other", storePath: otherPath } },
        entry: { sessionId: "other-row", updatedAt: 1 },
      }).hasBoard,
    ).toBe(false);
    const reads = (["all", "get", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    try {
      expect(facts.present().activitySummary).toEqual({
        text: "Prepared recap.",
        updatedAt: 1,
        state: "current",
      });
      expect(facts.present().activitySummary).toEqual({
        text: "Prepared recap.",
        updatedAt: 1,
        state: "current",
      });
      for (const read of reads) {
        expect(read).not.toHaveBeenCalled();
      }
    } finally {
      for (const read of reads) {
        read.mockRestore();
      }
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
    const refreshed = readSessionRowFacts({ cfg, target, entry });
    expect(refreshed.hasBoard).toBe(false);
    expect(refreshed.present().activitySummary?.state).toBe("stale");
  });
});
