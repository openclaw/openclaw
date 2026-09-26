import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { prepareSqliteTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { createRequiredWorkerSessionPreparation } from "./server-worker-required-profile.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import * as sessionWorktreePreparation from "./session-worktree-preparation.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  advancePlacementFixtureToActive,
  writePlacementEnvironmentFixture,
} from "./worker-environments/placement-test-fixtures.js";
import { createWorkerPlacementRedispatch } from "./worker-environments/worker-placement-redispatch.js";

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

// Real handler, config/session persistence and managed worktree lifecycle. Physical
// worker preparation is the boundary fixture; this is not provider execution proof.
test("a write-only ordinary create retains its owned workspace and unsent message when required preparation fails", async () => {
  const { storePath } = await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({ cloudWorkers: { requiredProfile: "dedicated-native" } });
  const key = "agent:main:dashboard:required-worker";
  const prepareRequiredSession = vi.fn<ReturnType<typeof createRequiredWorkerSessionPreparation>>(
    async (identity, assertCurrent) => {
      assertCurrent?.();
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(identity).toEqual({ agentId: "main", sessionKey: key, sessionId: entry?.sessionId });
      const workspace = managedWorktrees.findLiveByOwner("session", key);
      expect(workspace).toBeDefined();
      ownedWorktrees.add(workspace!.id);
      expect(entry).toMatchObject({
        worktree: { id: workspace!.id },
        sessionRoot: workspace!.path,
      });
      expect(await fs.readdir(workspace!.path)).toEqual([".git"]);
      throw new Error("Required worker is offline; reconnect it and retry.");
    },
  );
  const context = { workerPlacementDispatchService: { prepareRequiredSession } };
  const params = { key, agentId: "main", message: "" };
  const created = await directSessionReq<{
    key: string;
    sessionId: string;
    runStarted: boolean;
    runError?: { message: string };
  }>("sessions.create", params, { ...controlUiClient, context });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(prepareRequiredSession).toHaveBeenCalledOnce();
  expect(created.payload).toMatchObject({
    key,
    runStarted: false,
    runError: { message: expect.stringContaining("Required worker is offline") },
  });
  const workspace = managedWorktrees.findLiveByOwner("session", key)!;
  await fs.writeFile(workspace.path + "/retained.txt", "Keep accepted work.");
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.sessionId).toBe(
    created.payload?.sessionId,
  );
  const replay = await directSessionReq("sessions.create", params, { ...controlUiClient, context });
  expect(replay.ok, JSON.stringify(replay.error)).toBe(true);
  expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(workspace.id);
  expect(await fs.readFile(workspace.path + "/retained.txt", "utf8")).toBe("Keep accepted work.");
});

test.each([{ execNode: "other-device" }, { agentRuntime: "codex" }])(
  "required placement rejects an execution override before creating state: %j",
  async (override) => {
    const { storePath } = await createSessionStoreDir();
    const config = await getGatewayConfigModule();
    await config.writeConfigFile({ cloudWorkers: { requiredProfile: "dedicated-native" } });
    const key = "agent:main:dashboard:required-worker-override";
    const created = await directSessionReq(
      "sessions.create",
      { key, ...override },
      controlUiClient,
    );
    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: expect.stringContaining("requires worker profile"),
      },
    });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
    expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
  },
);

test("unconfigured ordinary create does not prepare a worker or create a managed worktree", async () => {
  await createSessionStoreDir();
  const config = await getGatewayConfigModule();
  await config.writeConfigFile({});
  const key = "agent:main:dashboard:optional-worker";
  const prepareRequiredSession = vi.fn();
  const created = await directSessionReq(
    "sessions.create",
    { key, message: "" },
    {
      ...controlUiClient,
      context: { workerPlacementDispatchService: { prepareRequiredSession } },
    },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(prepareRequiredSession).not.toHaveBeenCalled();
  expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
});

test.each(["channel", "incognito", "shared"] as const)(
  "required preparation uses the existing %s session owner and joins pending startup",
  async (kind) => {
    const createdStore = await createSessionStoreDir();
    const storePath =
      kind === "shared" ? path.join(createdStore.dir, "shared.sqlite") : createdStore.storePath;
    testState.sessionStorePath = storePath;
    const config = await getGatewayConfigModule();
    const agentId = kind === "shared" ? "ops" : "main";
    const key =
      kind === "incognito"
        ? "agent:main:dashboard:incognito-required-worker"
        : `agent:${agentId}:telegram:direct:required-worker`;
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
    const inbound =
      kind === "incognito"
        ? await (async () => {
            const created = await directSessionReq<{ key: string; sessionId: string }>(
              "sessions.create",
              { key, incognito: true, message: "" },
              {
                client: { connect: { scopes: ["operator.admin"] } } as never,
                context: {
                  workerPlacementDispatchService: { prepareRequiredSession: async () => {} },
                },
              },
            );
            expect(created.ok, JSON.stringify(created.error)).toBe(true);
            const owned = managedWorktrees.findLiveByOwner("session", key);
            if (owned) {
              ownedWorktrees.add(owned.id);
            }
            return {
              sessionKey: created.payload!.key,
              sessionEntry: { sessionId: created.payload!.sessionId },
            };
          })()
        : await initSessionState({
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
    if (kind !== "incognito") {
      expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
    }
    if (kind === "shared") {
      expect(
        (await prepareSqliteTranscriptReadScope({ ...identity, storePath })).databaseAgentId,
      ).toBe("main");
    }
    const placements = createWorkerSessionPlacementStore();
    const finish = createDeferredCore();
    const warn = vi.fn();
    // Dispatch is the existing coordinator boundary: this fixture records its real
    // durable admission and pauses provider work. No remote worker is simulated as live.
    const dispatch = vi.fn<
      Parameters<typeof createRequiredWorkerSessionPreparation>[0]["dispatch"]["dispatch"]
    >(async (request, onTransition, assertCurrent) => {
      assertCurrent?.();
      const requested = await placements.startDispatch(request);
      onTransition?.(requested);
      await finish.promise;
      const failed = placements.fail({
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
      await prepare(identity, undefined, undefined, { waitForReady: false });
      const worktree = managedWorktrees.findLiveByOwner("session", key)!;
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
      await prepare(identity, undefined, undefined, { waitForReady: false });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(managedWorktrees.findLiveByOwner("session", key)?.id).toBe(worktree.id);
    } finally {
      const owned = managedWorktrees.findLiveByOwner("session", key);
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

test.each(["missing", "different", "matching"] as const)(
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
    const provisioning = placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: requested.generation,
      patch: { environmentId: "original-environment" },
    });
    const failed = placements.fail({
      sessionId: identity.sessionId,
      expectedGeneration: provisioning.generation,
      recoveryError: "original allocation failed",
    });
    const reached = new Error("same recorded profile reached dispatch");
    const dispatch = vi.fn(async () => {
      throw reached;
    });
    const profileSnapshot = { settings: { device: "original-node", inference: "worker" } };
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      placements,
      environments: {
        get: () =>
          record === "missing"
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
      if (record === "matching") {
        await expect(prepare(identity)).rejects.toBe(reached);
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: "dedicated-native",
            inheritedProfile: { providerId: "device", profileSnapshot },
          }),
          expect.any(Function),
          expect.any(Function),
          expect.any(AbortSignal),
        );
      } else {
        await expect(prepare(identity)).rejects.toThrow(
          record === "missing"
            ? "recorded worker profile is unavailable"
            : "another worker profile",
        );
        expect(dispatch).not.toHaveBeenCalled();
        expect(managedWorktrees.findLiveByOwner("session", identity.sessionKey)).toBeUndefined();
        expect(placements.get(identity.sessionId)).toEqual(failed);
      }
    } finally {
      const owned = managedWorktrees.findLiveByOwner("session", identity.sessionKey);
      if (owned) {
        ownedWorktrees.add(owned.id);
      }
    }
  },
);

test.each([
  ["failed", false],
  ["reclaimed", false],
  ["failed", true],
] as const)(
  "required %s recovery (late=%s) retains the recorded profile and exact placement fence",
  async (state, late) => {
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
    const draining = placements.startDrain({ ...owner, expectedGeneration: active.generation });
    const reconciling = placements.startReconcile({
      ...owner,
      expectedGeneration: draining.generation,
    });
    if (state === "failed") {
      placements.fail({
        sessionId: identity.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "recoverable worker failure",
      });
    } else {
      placements.transition({
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
    if (late) {
      // The initial admission read predates failure; every re-read sees the real
      // persisted previously-active failure after lifecycle acquisition yields.
      vi.spyOn(placements, "get").mockReturnValueOnce(undefined);
      await expect(prepare(identity)).rejects.toThrow("Required worker placement is not ready");
      expect(recoveredDispatch).not.toHaveBeenCalled();
    } else {
      await expect(prepare(identity)).rejects.toBe(reached);
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
    expect(managedWorktrees.findLiveByOwner("session", identity.sessionKey)).toBeUndefined();
    expect(placements.get(identity.sessionId)).toEqual(terminal);
  },
);
