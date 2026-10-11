import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  installSessionPlacementAdmissionProvider,
  withRequiredSessionPlacement,
} from "../agents/session-placement-admission.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { prepareSqliteTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { canonicalSessionValidationQuery } from "../config/sessions/session-canonical-key.js";
import { validateCanonicalSessionRow } from "../config/sessions/session-canonical-row.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import {
  createGatewayWorkerDispatchAdmission,
  withGatewayWorkerSessionAdmission,
} from "./server-worker-placement-dispatch-admission.js";
import { createRequiredWorkerSessionPreparation as createRequiredPreparation } from "./server-worker-required-profile.js";
import * as sessionWorktreePreparation from "./session-worktree-preparation.js";
import { testState } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import type { WorkerPlacementDispatchService } from "./worker-environments/placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./worker-environments/placement-test-fixtures.js";
import type { ensureWorkerSessionPlacement } from "./worker-environments/session-placement-lifecycle.js";
import { createWorkerPlacementRedispatch } from "./worker-environments/worker-placement-redispatch.js";

function createRequiredWorkerSessionPreparation(
  options: Pick<
    Parameters<typeof ensureWorkerSessionPlacement>[0],
    "placements" | "environments" | "redispatchPlacement"
  > & {
    getConfig: () => OpenClawConfig;
    warn: (message: string) => void;
    dispatch: Pick<WorkerPlacementDispatchService, "dispatch"> & {
      waitForInitialPlacement?: unknown;
    };
  },
) {
  const dispatch = coordinateWorkerPlacementDispatch(
    options.dispatch as WorkerPlacementDispatchService,
    createGatewayWorkerDispatchAdmission(),
    undefined,
    undefined,
    options,
  );
  return createRequiredPreparation({ getConfig: options.getConfig, dispatch });
}

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const ownedWorktrees = new Set<string>();

afterEach(async () => {
  await disposeSessionReadContexts();
  for (const id of ownedWorktrees) {
    await managedWorktrees.remove({ id, reason: "test-cleanup", allowSnapshotLoss: true });
  }
  ownedWorktrees.clear();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

test.each(["channel", "shared"] as const)(
  "required preparation uses the existing %s session owner and joins pending startup",
  async (kind) => {
    const createdStore = await createSessionStoreDir();
    const storePath =
      kind === "shared" ? path.join(createdStore.dir, "shared.sqlite") : createdStore.storePath;
    testState.sessionStorePath = storePath;
    const config = await getGatewayConfigModule();
    const agentId = kind === "shared" ? "ops" : "main";
    const key = `agent:${agentId}:telegram:direct:required-worker`;
    await config.writeConfigFile({
      ...(kind === "shared" ? { agents: { entries: { main: {}, ops: {} } } } : {}),
      cloudWorkers: {
        requiredProfile: "dedicated-native",
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "test-node", inference: "worker" },
          },
        },
      },
    });
    if (kind === "shared") {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:shared-owner", storePath },
        { sessionId: "shared-owner", updatedAt: Date.now() },
      );
    }
    const inbound = await initSessionState({
      cfg: config.getRuntimeConfig(),
      commandAuthorized: true,
      ctx: finalizeInboundContext({
        Body: "Inspect my workspace",
        From: "telegram:synthetic-user",
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: key,
      }),
    });
    const identity = {
      agentId,
      sessionKey: inbound.sessionKey,
      sessionId: inbound.sessionEntry.sessionId,
    };
    expect(identity.sessionKey).toBe(key);
    expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    if (kind === "shared") {
      expect(
        (await prepareSqliteTranscriptReadScope({ ...identity, storePath })).databaseAgentId,
      ).toBe("main");
    }
    const placements = createWorkerSessionPlacementStore();
    const finish = createDeferredCore();
    let dispatchAssertion: (() => void) | undefined;
    const warn = vi.fn();
    // Dispatch is the existing coordinator boundary: this fixture records its real
    // durable admission and pauses provider work. No remote worker is simulated as live.
    const dispatch = vi.fn<
      Parameters<typeof createRequiredWorkerSessionPreparation>[0]["dispatch"]["dispatch"]
    >(async (request, onTransition, assertCurrent) => {
      dispatchAssertion = assertCurrent;
      const sql = observeHostDataSql();
      try {
        assertCurrent?.();
        assertCurrent?.();
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      const requested = await placements.startDispatch(request);
      onTransition?.(requested);
      await finish.promise;
      const failed = await placements.fail({
        sessionId: request.sessionId,
        expectedGeneration: requested.generation,
        recoveryError: "Synthetic provider unavailable",
      });
      onTransition?.(failed);
      throw new Error("Synthetic provider unavailable");
    });
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      placements,
      warn,
      environments: { get: () => undefined } as never,
      redispatchPlacement: vi.fn(),
      dispatch: { dispatch, waitForInitialPlacement: vi.fn() } as never,
    });
    try {
      let retainedAssertion: (() => void) | undefined;
      await prepare(
        identity,
        async (assertCurrent) => {
          const sql = observeHostDataSql();
          try {
            assertCurrent();
            assertCurrent();
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
          retainedAssertion = assertCurrent;
        },
        undefined,
        undefined,
        { waitForReady: false },
      );
      expect(() => retainedAssertion!()).toThrow("scope was released");
      const worktree = (await managedWorktrees.findLiveByOwner("session", key))!;
      ownedWorktrees.add(worktree.id);
      expect(await fs.readdir(worktree.path)).toEqual([".git"]);
      expect(loadSessionEntry({ ...identity, storePath })).toMatchObject({
        worktree: { id: worktree.id },
        sessionRoot: worktree.path,
        spawnedCwd: worktree.path,
      });
      expect(placements.get(identity.sessionId)).toMatchObject({
        state: "requested",
        executionMode: "worker-turn",
        sessionKey: key,
      });
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        ...identity,
        profileId: "dedicated-native",
        requiredProfile: "dedicated-native",
        runSetupScript: false,
      });
      await prepare(identity, async (assertCurrent) => assertCurrent(), undefined, undefined, {
        waitForReady: false,
      });
      expect(dispatch).toHaveBeenCalledOnce();
      expect((await managedWorktrees.findLiveByOwner("session", key))?.id).toBe(worktree.id);
      // Coordinator custody survives RPC completion, not a runtime selection change.
      expect(() => dispatchAssertion!()).not.toThrow();
      await patchSessionEntryCore({ ...identity, storePath }, () => ({ execNode: "other-node" }));
      expect(() => dispatchAssertion!()).toThrow("Session changed during worker admission");
    } finally {
      const owned = await managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        ownedWorktrees.add(owned.id);
      }
      finish.resolve();
      if (dispatch.mock.results.length > 0) {
        // Await the actual retained operation, so cleanup cannot close its source early.
        await dispatch.mock.results[0]?.value.catch(() => undefined);
        const failed = placements.get(identity.sessionId)!;
        expect(failed).toMatchObject({
          state: "failed",
          recoveryError: "Synthetic provider unavailable",
        });
        placements.retireSessionPlacement({
          sessionId: identity.sessionId,
          expectedState: "failed",
          expectedGeneration: failed.generation,
        });
      }
    }
  },
);

test("required preparation awaits rejection of a missing repository workspace before dispatch", async () => {
  const { storePath } = await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({
    cloudWorkers: {
      requiredProfile: "dedicated-native",
      profiles: { "dedicated-native": { provider: "device", settings: { device: "node" } } },
    },
  });
  const identity = {
    agentId: "main",
    sessionKey: "agent:main:missing-required-workspace",
    sessionId: "missing-required-workspace",
  };
  await upsertSessionEntryCore(
    { ...identity, storePath },
    { sessionId: identity.sessionId, updatedAt: Date.now(), repositoryWorkspaceId: "missing" },
  );
  const dispatch = vi.fn(async () => {
    throw new Error("Dispatch must not run without its workspace owner");
  });
  const prepare = createRequiredWorkerSessionPreparation({
    getConfig: config.getRuntimeConfig,
    placements: createWorkerSessionPlacementStore(),
    environments: { get: () => undefined } as never,
    warn: vi.fn(),
    redispatchPlacement: vi.fn(),
    dispatch: { dispatch, waitForInitialPlacement: vi.fn() } as never,
  });
  await expect(prepare(identity, async (assertCurrent) => assertCurrent())).rejects.toThrow(
    "The session workspace owner is unavailable",
  );
  expect(dispatch).not.toHaveBeenCalled();
});

test.each(["unchanged", "caller", "runtime"] as const)(
  "required workspace commit fences %s authority after preparation",
  async (change) => {
    const { dir } = await createSessionStoreDir();
    const storePath = path.join(dir, "sessions.sqlite");
    testState.sessionStorePath = storePath;
    const config = await getGatewayConfigModule();
    await config.writeConfigFile({
      cloudWorkers: {
        requiredProfile: "dedicated-native",
        profiles: {
          "dedicated-native": { provider: "device", settings: { device: "test-node" } },
        },
      },
    });
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:required-commit",
      sessionId: "required-commit",
    };
    const caller = {
      agentId: "main",
      sessionKey: "agent:main:required-caller",
      sessionId: "required-caller",
    };
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: 1 },
    );
    await upsertSessionEntryCore(
      { ...caller, storePath },
      { sessionId: caller.sessionId, updatedAt: 1, thinkingLevel: "high" },
    );
    const reachedDispatch = new Error("Reached required worker dispatch");
    const dispatch = vi.fn<WorkerPlacementDispatchService["dispatch"]>(async () => {
      throw reachedDispatch;
    });
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      placements: createWorkerSessionPlacementStore(),
      environments: { get: () => undefined } as never,
      warn: vi.fn(),
      redispatchPlacement: vi.fn(),
      dispatch: { dispatch, waitForInitialPlacement: vi.fn() } as never,
    });
    const uninstall = installSessionPlacementAdmissionProvider({
      withRequiredSession: prepare,
      assertCompactionSuccessorAllowed() {},
      executeLocalTurn: async (_claim, run) => await run(),
      executeTurn: async (_claim, _params, run) => await run(),
    });
    const prepareWorktree = sessionWorktreePreparation.prepareSessionWorktree;
    let preparedWorktreePath: string | undefined;
    vi.spyOn(sessionWorktreePreparation, "prepareSessionWorktree").mockImplementation(
      async (params) => {
        const result = await prepareWorktree(params);
        if (!result.ok) {
          return result;
        }
        preparedWorktreePath = result.value.sessionRoot;
        expect(preparedWorktreePath).toEqual(expect.any(String));
        // A separate connection cannot publish into either admitted source's host projection.
        if (change !== "unchanged") {
          const foreign = new (requireNodeSqlite().DatabaseSync)(storePath);
          try {
            const sessionKey = change === "caller" ? caller.sessionKey : identity.sessionKey;
            const database = { agentId: "main", db: foreign };
            runSqliteImmediateTransactionSync(foreign, () => {
              const update = foreign
                .prepare(
                  "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
                )
                .run(
                  change === "caller" ? "$.thinkingLevel" : "$.execNode",
                  change === "caller" ? "off" : "other-node",
                  sessionKey,
                );
              expect(update.changes).toBe(1);
              const row = executeSqliteQueryTakeFirstSync(
                foreign,
                canonicalSessionValidationQuery(database).where(
                  "session_nodes.session_key",
                  "=",
                  sessionKey,
                ),
              );
              if (!row) {
                throw new Error("Foreign entry mutation lost its existing row");
              }
              // Validate the synthetic external writer's stored bytes; publish no host authority.
              validateCanonicalSessionRow(row, "read");
              foreign
                .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
                .run(sessionKey);
            });
          } finally {
            foreign.close();
          }
        }
        return result;
      },
    );
    try {
      const pending = withGatewayWorkerSessionAdmission(
        {
          identity: caller,
          getConfig: config.getRuntimeConfig,
          retainEntryFields: ["thinkingLevel"],
        },
        async (source) =>
          await withRequiredSessionPlacement(
            identity,
            { config: config.getRuntimeConfig(), assertCurrent: source.assertCurrent },
            async () => {
              throw new Error("A worker turn cannot run before provider dispatch");
            },
          ),
      );
      if (change === "unchanged") {
        await expect(pending).rejects.toBe(reachedDispatch);
        expect(dispatch).toHaveBeenCalledOnce();
        const worktree = (await managedWorktrees.findLiveByOwner("session", identity.sessionKey))!;
        expect(loadSessionEntry({ ...identity, storePath })).toMatchObject({
          worktree: { id: worktree.id },
          sessionRoot: worktree.path,
          spawnedCwd: worktree.path,
        });
      } else {
        await expect(pending).rejects.toThrow("Session changed during worker admission");
        expect(dispatch).not.toHaveBeenCalled();
        const entry = loadSessionEntry({ ...identity, storePath });
        expect(entry).not.toHaveProperty("worktree");
        expect(entry).not.toHaveProperty("sessionRoot");
        expect(entry).not.toHaveProperty("spawnedCwd");
        expect(
          await managedWorktrees.findLiveByOwner("session", identity.sessionKey),
        ).toBeUndefined();
        expect(preparedWorktreePath).toBeDefined();
        await expect(fs.stat(preparedWorktreePath!)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      uninstall();
      const worktree = await managedWorktrees.findLiveByOwner("session", identity.sessionKey);
      if (worktree) {
        ownedWorktrees.add(worktree.id);
      }
    }
  },
);

test.each(["unallocated", "missing", "different", "matching"] as const)(
  "required retry respects a failed placement with %s recorded environment",
  async (record) => {
    const { storePath } = await createSessionStoreDir();
    const config = await getGatewayConfigModule();
    await config.writeConfigFile({
      cloudWorkers: {
        requiredProfile: "dedicated-native",
        profiles: {
          "dedicated-native": {
            provider: "device",
            settings: { device: "new-node", inference: "worker" },
          },
        },
      },
    });
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:required-retry",
      sessionId: "required-retry",
    };
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: Date.now() },
    );
    const placements = createWorkerSessionPlacementStore();
    const requested = await placements.startDispatch({ ...identity, executionMode: "worker-turn" });
    const provisioning = await placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: record === "unallocated" ? {} : { environmentId: "original-environment" },
    });
    const failed = await placements.fail({
      sessionId: identity.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "original allocation failed",
    });
    const reached = new Error("same recorded profile reached dispatch");
    const dispatch = vi.fn<WorkerPlacementDispatchService["dispatch"]>(async () => {
      throw reached;
    });
    const profileSnapshot = { settings: { device: "original-node", inference: "worker" } };
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      placements,
      environments: {
        get: () =>
          record === "missing" || record === "unallocated"
            ? undefined
            : {
                state: "destroyed",
                profileId: record === "different" ? "original-profile" : "dedicated-native",
                providerId: "device",
                profileSnapshot,
              },
      } as never,
      warn: vi.fn(),
      redispatchPlacement: vi.fn(),
      dispatch: { dispatch, waitForInitialPlacement: vi.fn() } as never,
    });
    try {
      if (record === "matching" || record === "unallocated") {
        await expect(prepare(identity, async (assertCurrent) => assertCurrent())).rejects.toBe(
          reached,
        );
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: "dedicated-native",
            ...(record === "matching"
              ? { inheritedProfile: { providerId: "device", profileSnapshot } }
              : {}),
          }),
          expect.any(Function),
          expect.any(Function),
          expect.any(AbortSignal),
        );
        if (record === "unallocated") {
          expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("inheritedProfile");
        }
      } else {
        await expect(prepare(identity, async (assertCurrent) => assertCurrent())).rejects.toThrow(
          record === "missing"
            ? "recorded worker profile is unavailable"
            : "another worker profile",
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          await managedWorktrees.findLiveByOwner("session", identity.sessionKey),
        ).toBeUndefined();
        expect(placements.get(identity.sessionId)).toEqual(failed);
      }
    } finally {
      const owned = await managedWorktrees.findLiveByOwner("session", identity.sessionKey);
      if (owned) {
        ownedWorktrees.add(owned.id);
      }
    }
  },
);

test.each(["failed", "reclaimed"] as const)(
  "required %s recovery retains the recorded profile and exact placement fence",
  async (state) => {
    const { storePath } = await createSessionStoreDir();
    const config = await getGatewayConfigModule();
    await config.writeConfigFile({
      cloudWorkers: {
        requiredProfile: "dedicated-native",
        profiles: {
          "dedicated-native": { provider: "device", settings: { device: "new-node" } },
        },
      },
    });
    const identity = {
      agentId: "main",
      sessionKey: "agent:main:required-recovery",
      sessionId: "required-recovery",
    };
    await upsertSessionEntryCore(
      { ...identity, storePath },
      { sessionId: identity.sessionId, updatedAt: Date.now() },
    );
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const profileSnapshot = { settings: { device: "original-node", inference: "worker" } };
    const originalEnvironment = {
      environmentId: "environment-placement-claim-close",
      state: "attached" as const,
      ownerEpoch: 7,
      attachedSessionIds: [identity.sessionId],
      leaseId: "retired-native-lease",
      providerId: "device",
      profileId: "dedicated-native",
      nodeDeviceId: "original-node",
      profileSnapshot,
    };
    // Allocation records the immutable profile before activation; later state updates
    // deliberately cannot rewrite that snapshot to the currently configured device.
    writePlacementEnvironmentFixture(database, originalEnvironment);
    const active = await advancePlacementFixtureToActive(placements, database, identity);
    const owner = {
      sessionId: identity.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
    };
    const draining = await placements.startDrain({
      ...owner,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      ...owner,
      expectedGeneration: draining.generation,
    });
    if (state === "failed") {
      await placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "recoverable worker failure",
      });
    } else {
      await placements.transition({
        sessionId: identity.sessionId,
        from: "reconciling",
        to: "reclaimed",
        expectedGeneration: reconciling.generation,
      });
    }
    const environment = {
      ...originalEnvironment,
      state: "destroyed" as const,
      attachedSessionIds: [],
    };
    writePlacementEnvironmentFixture(database, environment);
    const terminal = placements.get(identity.sessionId)!;
    const reached = new Error("recorded recovery reached dispatch");
    const recoveredDispatch = vi.fn(async () => {
      throw reached;
    });
    const freshDispatch = vi.fn();
    const freshWorkspace = vi
      .spyOn(sessionWorktreePreparation, "prepareSessionWorktree")
      .mockRejectedValue(new Error("fresh workspace setup reached"));
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      placements,
      environments: { get: () => environment } as never,
      warn: vi.fn(),
      redispatchPlacement: createWorkerPlacementRedispatch({
        placements,
        dispatch: recoveredDispatch,
        resolveDevicePlacementRequirement: async () => ({
          requiredNodeCommands: [],
          consumesWorkerSlot: true,
        }),
      }),
      dispatch: { dispatch: freshDispatch, waitForInitialPlacement: vi.fn() } as never,
    });
    {
      await expect(prepare(identity, async (assertCurrent) => assertCurrent())).rejects.toBe(
        reached,
      );
      expect(recoveredDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          ...identity,
          profileId: "dedicated-native",
          requiredProfile: "dedicated-native",
          deviceId: "original-node",
          inheritedProfile: { providerId: "device", profileSnapshot },
          expectedPlacement: {
            state,
            generation: terminal.generation,
            environmentId: terminal.environmentId,
            activeOwnerEpoch: terminal.activeOwnerEpoch,
          },
        }),
        undefined,
        expect.any(Function),
        expect.any(AbortSignal),
      );
    }
    expect(freshDispatch).not.toHaveBeenCalled();
    expect(freshWorkspace).not.toHaveBeenCalled();
    expect(await managedWorktrees.findLiveByOwner("session", identity.sessionKey)).toBeUndefined();
    expect(placements.get(identity.sessionId)).toEqual(terminal);
  },
);
