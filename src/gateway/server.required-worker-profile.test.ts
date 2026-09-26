import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { prepareSqliteTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { createRequiredWorkerSessionPreparation } from "./server-worker-required-profile.js";
import { controlUiClient } from "./server.sessions.create.projects.test-support.js";
import { testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

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
      const requested = placements.startDispatch(request);
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
      redispatchReclaimed: vi.fn(),
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
