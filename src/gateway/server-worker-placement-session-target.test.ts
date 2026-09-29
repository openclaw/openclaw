import { afterEach, expect, test, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import * as repositoryPublications from "../state/session-repository-workspaces.publication.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => resetConfigRuntimeState());

test("rejects stale repository selection and refreshes the accepted checkpoint after drain", async () => {
  await withStateDirEnv("worker-repository-selection-", async () => {
    const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(config, config);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: REQUEST.agentId });
    const repositories = getSessionRepositoryWorkspaceStore();
    const created = await repositories.create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/openclaw/fixture.git",
      assertCurrent: () => {},
    });
    const bound = await repositories.bindBase({
      workspaceId: created.workspaceId,
      expectedRevision: created.revision,
      baseCommit: "a".repeat(40),
      baseManifestHash: `sha256:${"b".repeat(64)}`,
      assertCurrent: () => {},
    });
    await replaceSessionEntry(
      { storePath, sessionKey: REQUEST.sessionKey, agentId: REQUEST.agentId },
      {
        sessionId: REQUEST.sessionId,
        lifecycleRevision: "repository-selection",
        repositoryWorkspaceId: bound.workspaceId,
        updatedAt: 1,
      },
    );
    const sessionRuntime = {
      resolveGatewaySessionStoreTargetWithStore,
      resolveCanonicalSessionEntryFromStoreKeys,
      managedWorktrees: { findLiveByOwner: () => undefined },
    };
    const select = () =>
      resolveWorkerPlacementSessionTarget({
        sessionRuntime,
        config,
        ...REQUEST,
        errorMessage: "repository selection changed",
      });
    const selected = await select();
    selected.assertCurrent();
    const accepted = await repositories.acceptCheckpoint({
      workspaceId: bound.workspaceId,
      expectedRevision: bound.revision,
      checkpointRef: "refs/openclaw/worker-results/selected-next",
      manifestHash: `sha256:${"c".repeat(64)}`,
      assertCurrent: () => {},
    });
    expect(selected.workspace).toEqual({ kind: "repository", repository: bound });
    expect(() => selected.assertCurrent()).toThrow("repository selection changed");
    selected.assertBindingCurrent();
    const refreshed = await select();
    refreshed.assertCurrent();
    expect(refreshed.workspace).toEqual({ kind: "repository", repository: accepted });

    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const environment = { environmentId: "repository-selection-worker", ownerEpoch: 1 };
    seedAttachedPlacementEnvironment(database, { ...environment, sessionId: REQUEST.sessionId });
    await seedActivePlacement(placements, environment);
    let drained = accepted;
    let checkedPendingPublication = false;
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: async () => sessionRuntime,
      cancelSessionWork: async (request) => {
        const stage = repositoryPublications.stageRepositoryWorkspacePublication;
        const observation = vi
          .spyOn(repositoryPublications, "stageRepositoryWorkspacePublication")
          .mockImplementation((...args) => {
            const publication = stage(...args);
            if (args[1].workspaceId === accepted.workspaceId) {
              request.assertCurrent();
              checkedPendingPublication = true;
            }
            return publication;
          });
        try {
          drained = await repositories.acceptCheckpoint({
            workspaceId: accepted.workspaceId,
            expectedRevision: accepted.revision,
            checkpointRef: "refs/openclaw/worker-results/drained-next",
            manifestHash: `sha256:${"d".repeat(64)}`,
            assertCurrent: request.assertCurrent,
          });
          request.assertCurrent();
        } finally {
          observation.mockRestore();
        }
      },
      revokeSessionAuthority: () => {},
    });
    const reclaimed = await barriers.runReclaimBarrier({
      ...REQUEST,
      begin: () => {
        const current = placements.get(REQUEST.sessionId);
        if (current?.state !== "active") {
          throw new Error("Expected active placement before reclaim");
        }
        const result = placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        if (result.state !== "draining") {
          throw new Error("Expected draining placement");
        }
        return result;
      },
      reclaim: async (workspace, current) => {
        expect(workspace).toEqual({ kind: "repository", repository: drained });
        if (current.state !== "draining") {
          throw new Error("Expected a newly drained placement");
        }
        const reconciling = placements.startReconcile({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        const result = placements.transition({
          sessionId: current.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: reconciling.generation,
        });
        if (result.state !== "reclaimed") {
          throw new Error("Expected reclaimed placement");
        }
        return result;
      },
    });
    expect(checkedPendingPublication).toBe(true);
    expect(drained.revision).toBe(accepted.revision + 1);
    expect(reclaimed.state).toBe("reclaimed");
  });
});

test("resolves consecutive placement workspaces without decoding unrelated session payloads", async () => {
  await withStateDirEnv("worker-exact-target-", async () => {
    const config: OpenClawConfig = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(config, config);
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const keys = ["agent:main:placement-a", "agent:main:placement-b"] as const;
    for (const key of keys) {
      await replaceSessionEntry(
        { storePath, sessionKey: key },
        {
          sessionId: key,
          updatedAt: 1,
          worktree: { id: key, branch: "synthetic", repoRoot: "/synthetic" },
        },
      );
    }
    for (let index = 0; index < 24; index++) {
      await replaceSessionEntry(
        { storePath, sessionKey: `agent:main:unrelated-${index}` },
        {
          sessionId: `unrelated-payload-${index}`,
          updatedAt: 1,
          skillsSnapshot: { prompt: "unrelated-payload-" + "x".repeat(4096), skills: [] },
        },
      );
    }
    // Canonical store admission runs once before repeated startup workspace lookups.
    expect(loadExactSessionEntryReadOnly({ storePath, sessionKey: keys[0] })?.entry).toBeDefined();
    const parse = vi.spyOn(JSON, "parse");
    try {
      for (const sessionKey of keys) {
        const resolved = await resolveWorkerPlacementSessionTarget({
          sessionRuntime: {
            resolveGatewaySessionStoreTargetWithStore,
            resolveCanonicalSessionEntryFromStoreKeys,
            managedWorktrees: {
              findLiveByOwner: (_kind, ownerId) => ({
                id: ownerId,
                ownerId,
                path: `/synthetic/${ownerId}`,
              }),
            },
          },
          config,
          sessionId: sessionKey,
          sessionKey,
          agentId: "main",
          errorMessage: "placement identity changed",
        });
        expect(resolved.entry.sessionId).toBe(sessionKey);
        expect(resolved.workspace).toEqual({ kind: "local", path: `/synthetic/${sessionKey}` });
      }
      expect(
        parse.mock.calls.filter(([value]) => value.includes("unrelated-payload-")),
      ).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }
  });
});
