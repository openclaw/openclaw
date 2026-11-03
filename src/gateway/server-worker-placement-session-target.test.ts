import { afterEach, expect, test, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { createSessionActorReplica } from "../config/sessions/session-actor-replica.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import * as publications from "../state/session-repository-workspaces.publication.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import {
  resolveWorkerPlacementSessionTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import { LOCAL_PLACEMENT } from "./worker-environments/placement-dispatch-coordinator.test-support.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

afterEach(() => {
  memorySessionActorOwners.reset();
  resetConfigRuntimeState();
});

const sessionRuntime = (
  findLiveByOwner: WorkerPlacementSessionRuntime["managedWorktrees"]["findLiveByOwner"] = async () =>
    undefined,
): WorkerPlacementSessionRuntime => ({
  resolveGatewaySessionStoreTargetInWorker,
  resolveCanonicalSessionEntryFromStoreKeys,
  managedWorktrees: { findLiveByOwner },
});

const createWorktree = (name: string, ownerId: string) =>
  managedWorktrees.createEmpty({
    name,
    ownerKind: "session",
    ownerId,
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });

async function createActor(sessionKey: string, entry: InternalSessionEntry) {
  const owner = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
  });
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const result = await actor.storage!.mutate(
    { type: "session.entry.create", input: { entry } },
    { assertCurrent() {}, authorize() {} },
  );
  expect(result.kind).toBe("committed");
  return { owner, [Symbol.asyncDispose]: () => actor.release() };
}

function targetFixture(sessionKey: string, sessionId = sessionKey) {
  const identity = { agentId: "main", sessionKey, sessionId };
  const scope = {
    ...identity,
    storePath: resolveSessionStorePathCore(undefined, { agentId: identity.agentId }),
  };
  return {
    identity,
    scope,
    read: () => loadExactSessionEntryReadOnly(scope)?.entry,
    write: (entry: Partial<InternalSessionEntry>) =>
      replaceSessionEntry(scope, { sessionId, updatedAt: 1, ...entry }),
    patch: (entry: Partial<InternalSessionEntry>) => patchSessionEntryCore(scope, () => entry),
    select: (runtime = sessionRuntime(), errorMessage = "placement source changed") =>
      resolveWorkerPlacementSessionTarget({
        ...identity,
        config: getRuntimeConfig(),
        errorMessage,
        sessionRuntime: runtime,
      }),
  };
}

function assertState<S extends string>(
  value: { state: string } | undefined,
  state: S,
): asserts value is { state: S } {
  expect(value?.state).toBe(state);
}

const worktreeEntry = ({
  id,
  branch,
  repoRoot,
}: NonNullable<InternalSessionEntry["worktree"]>) => ({ id, branch, repoRoot });
const syntheticWorktree = (id: string) => ({ id, branch: "synthetic", repoRoot: "/synthetic" });

function withTargetState(
  name: string,
  run: () => Promise<void>,
  config: OpenClawConfig = { agents: { entries: { main: {} } } },
) {
  return withStateDirEnv(name, () => {
    setRuntimeConfigSnapshot(config, config);
    return run();
  });
}
const withEmptyTargetState = (name: string, run: () => Promise<void>) =>
  withTargetState(name, run, {});

async function withoutHostSql<T>(run: () => T | Promise<T>, observe = true) {
  if (!observe) {
    return run();
  }
  const sql = observeHostDataSql();
  try {
    const result = await run();
    expect(sql.queries).toEqual([]);
    return result;
  } finally {
    sql.restore();
  }
}

test.each([false, true])(
  "guards durable workspace facts across cache invalidation=%s without host SQL",
  (invalidateCache) =>
    (invalidateCache ? withTargetState : withEmptyTargetState)(
      "durable-placement-source-",
      async () => {
        const fixture = targetFixture("agent:main:placement-source", "placement-source");
        const { identity, scope } = fixture;
        await fixture.write({
          lifecycleRevision: "original",
          worktree: syntheticWorktree("original"),
        });
        let resolved: Awaited<ReturnType<typeof resolveWorkerPlacementSessionTarget>> | undefined;
        try {
          const current = await withoutHostSql(async () => {
            resolved = await fixture.select(
              sessionRuntime(async () => {
                if (invalidateCache) {
                  const physical = readDatabasePathIdentitySync(scope.storePath);
                  const replica = createSessionActorReplica({
                    target: {
                      sessionKey: identity.sessionKey,
                      database: {
                        kind: "file",
                        physicalIdentity: physical.key.slice("file:".length),
                        birthtime: physical.birthtime,
                        nativeLocation: scope.storePath,
                      },
                    },
                    lifetime: { assertCurrent() {}, assertReadable() {} },
                    currentGeneration: () => "retained-workspace-fixture",
                  });
                  replica.invalidate();
                  replica.close();
                }
                return { id: "original", ownerId: identity.sessionKey, path: "/synthetic" };
              }),
            );
            expect(resolved.workspace).toEqual({ kind: "local", path: "/synthetic" });
            resolved.assertCurrent();
            return resolved;
          }, !invalidateCache);
          await fixture.patch({ label: "unrelated" });
          expect(current.assertCurrent).not.toThrow();
          await fixture.patch({ worktree: syntheticWorktree("replacement") });
          await withoutHostSql(
            () => expect(current.assertCurrent).toThrow("placement source changed"),
            !invalidateCache,
          );
        } finally {
          resolved?.[Symbol.dispose]();
        }
      },
    ),
);

test("prepares an actor workspace and guards exact placement metadata without host session SQL", () =>
  withEmptyTargetState("actor-placement-source-", async () => {
    const fixture = targetFixture(
      "agent:main:dashboard:incognito-placement-source",
      "placement-source",
    );
    const { identity } = fixture;
    const worktree = await createWorktree("actor-placement", identity.sessionKey);
    await using memory = await createActor(identity.sessionKey, {
      sessionId: identity.sessionId,
      updatedAt: Date.now(),
      lifecycleRevision: "placement-window",
      incognito: true,
      projectId: "full-planning-project",
      worktree: worktreeEntry(worktree),
    });
    await withoutHostSql(async () => {
      using resolved = await fixture.select(
        sessionRuntime((...args) => managedWorktrees.findLiveByOwner(...args)),
      );
      expect(resolved.workspace).toEqual({ kind: "local", path: worktree.path });
      expect(resolved.entry.projectId).toBe("full-planning-project");
      const scope = { ...identity, storePath: memory.owner.path };
      await patchSessionEntryCore(scope, () => ({ label: "unrelated title" }));
      expect(resolved.assertCurrent).not.toThrow();
      await patchSessionEntryCore(scope, () => ({
        worktree: { id: "replacement", branch: worktree.branch, repoRoot: worktree.repoRoot },
      }));
      expect(resolved.assertCurrent).toThrow("placement source changed");
    });
  }));

test("refreshes stale repository selection after checkpoint drain", () =>
  withTargetState("worker-repository-selection-", async () => {
    const fixture = targetFixture(REQUEST.sessionKey, REQUEST.sessionId);
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
    await fixture.write({
      lifecycleRevision: "repository-selection",
      repositoryWorkspaceId: bound.workspaceId,
    });
    const repositoryRuntime = sessionRuntime();
    const select = () => fixture.select(repositoryRuntime, "repository selection changed");
    using selected = await select();
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
    using refreshed = await select();
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
      loadSessionRuntime: async () => repositoryRuntime,
      cancelSessionWork: async (request) => {
        const stage = publications.stageRepositoryWorkspacePublication;
        const observation = vi
          .spyOn(publications, "stageRepositoryWorkspacePublication")
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
      begin: async () => {
        const current = placements.get(REQUEST.sessionId);
        assertState(current, "active");
        const result = await placements.startDrain({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        assertState(result, "draining");
        return result;
      },
      reclaim: async (workspace, current) => {
        expect(workspace).toEqual({ kind: "repository", repository: drained });
        assertState(current, "draining");
        const reconciling = await placements.startReconcile({
          sessionId: current.sessionId,
          environmentId: current.environmentId,
          ownerEpoch: current.activeOwnerEpoch,
          expectedGeneration: current.generation,
        });
        const result = await placements.transition({
          sessionId: current.sessionId,
          from: "reconciling",
          to: "reclaimed",
          expectedGeneration: reconciling.generation,
        });
        assertState(result, "reclaimed");
        return result;
      },
    });
    expect(checkedPendingPublication).toBe(true);
    expect(drained.revision).toBe(accepted.revision + 1);
    expect(reclaimed.state).toBe("reclaimed");
  }));

test("resolves device folders without Git or the managed-worktree registry", () =>
  withEmptyTargetState("device-folder-target-", async () => {
    const fixture = targetFixture(
      "agent:main:dashboard:incognito-device-folder",
      "device-folder-session",
    );
    const { identity } = fixture;
    await using memory = await createActor(identity.sessionKey, {
      sessionId: identity.sessionId,
      updatedAt: 1,
      lifecycleRevision: "folder-generation",
      incognito: true,
      deviceFolder: { deviceId: "paired-device", path: "/existing/non-git" },
    });
    const findLiveByOwner = vi.fn(async () => undefined);
    using resolved = await fixture.select(
      sessionRuntime(findLiveByOwner),
      "folder binding changed",
    );
    expect(resolved.workspace).toEqual({
      kind: "device-folder",
      deviceId: "paired-device",
      path: "/existing/non-git",
    });
    expect(findLiveByOwner).not.toHaveBeenCalled();
    await patchSessionEntryCore({ ...identity, storePath: memory.owner.path }, () => ({
      deviceFolder: { deviceId: "another-device", path: "/existing/non-git" },
    }));
    expect(() => resolved.assertCurrent()).toThrow("folder binding changed");
  }));

test("reclaim retains session generation through its workspace metadata commit", () =>
  withTargetState("worker-reclaim-metadata-", async () => {
    const fixture = targetFixture(REQUEST.sessionKey, REQUEST.sessionId);
    const { scope } = fixture;
    await fixture.write({
      lifecycleRevision: "reclaim-generation",
      repositoryWorkspaceId: "accepted-repository",
    });
    const placement = { ...LOCAL_PLACEMENT, ...REQUEST };
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements: {
        get: () => placement,
        getAsync: async () => placement,
        waitForTurnClaimRelease: async () => {},
      },
      loadSessionRuntime: async () => sessionRuntime(),
      cancelSessionWork: async () => {},
      revokeSessionAuthority: () => {},
    });
    const reclaimed = await barriers.runReclaimPreparation({
      ...REQUEST,
      run: async (authorize) => {
        await patchSessionEntryCore(
          scope,
          () => ({ repositoryWorkspaceId: undefined, spawnedCwd: "/accepted-workspace" }),
          { assertCommitAllowed: authorize, skipMaintenance: true },
        );
        authorize?.();
        return placement;
      },
    });
    expect(reclaimed).toBe(placement);
    expect(fixture.read()).toMatchObject({
      sessionId: REQUEST.sessionId,
      lifecycleRevision: "reclaim-generation",
      spawnedCwd: "/accepted-workspace",
    });
  }));
