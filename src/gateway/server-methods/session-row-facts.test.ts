import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import {
  loadSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { beginSessionPermissionChange } from "../session-permission-change.js";
import { DEVICE_WORKER_PROVIDER_ID } from "../worker-environments/device-provider-identity.js";
import { createWorkerPlacementRunnerAvailabilityReader } from "../worker-environments/placement-projector.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "../worker-environments/placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "../worker-environments/store.js";
import { readSessionRowFacts } from "./session-placement-read-projection.js";

afterEach(() => vi.restoreAllMocks());

it("retains exact placement/environment facts while presenting live disk and runner observations without SQLite", async () => {
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
      readMachineShape: () => ({ cpu: 4, memoryGb: 16 }),
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
    } finally {
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
