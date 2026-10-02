import { afterEach, expect, test, vi } from "vitest";
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
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import * as repositoryPublications from "../state/session-repository-workspaces.publication.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "./server-worker-placement-reclaim.js";
import { resolveWorkerPlacementSessionTarget } from "./server-worker-placement-session-target.js";
import { createGatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "./session-utils-store.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./worker-environments/placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";

afterEach(() => resetConfigRuntimeState());

test.each([
  { scope: "individual", inherited: false },
  { scope: "global", inherited: false },
  { scope: "individual", inherited: true },
  { scope: "global", inherited: true },
] as const)(
  "full target recovery probe under $scope scope (inherited=$inherited)",
  async ({ scope, inherited }) => {
    await withStateDirEnv("full-target-recovery-probe-", async () => {
      const profile = { provider: "full-target-probe", settings: { region: "synthetic" } };
      const individual: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        cloudWorkers: { profiles: { development: profile } },
      };
      setRuntimeConfigSnapshot(individual, individual);
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "captured-main-window",
      };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: identity.agentId });
      if (inherited) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: "agent:main:model-parent", storePath },
          {
            sessionId: "placement-model-parent",
            updatedAt: 1,
            providerOverride: "anthropic",
            modelOverride: "claude-test",
          },
        );
      }
      const originalWorktree = await managedWorktrees.createEmpty({
        name: "full-target-original",
        ownerKind: "session",
        ownerId: identity.sessionKey,
        runSetupScript: false,
        provisionIgnoredFiles: false,
      });
      await replaceSessionEntry(
        { ...identity, storePath },
        {
          sessionId: identity.sessionId,
          updatedAt: 1,
          lifecycleRevision: "original-window",
          ...(inherited
            ? { parentSessionKey: "agent:main:model-parent" }
            : { providerOverride: "anthropic", modelOverride: "claude-test" }),
          worktree: {
            id: originalWorktree.id,
            branch: originalWorktree.branch,
            repoRoot: originalWorktree.repoRoot,
          },
        },
      );
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database });
      const environmentStore = await createWorkerEnvironmentStore({ database });
      const environmentId = "full-target-worker";
      const intent = await environmentStore.createIntent({
        environmentId,
        providerId: profile.provider,
        profileId: "development",
        profileSnapshot: profile,
        provisionOperationId: "full-target-provision",
      });
      await environmentStore.transition({
        environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const requested = await placements.startDispatch({
        ...identity,
        executionMode: "worker-turn",
      });
      const captured = placements.transition({
        sessionId: identity.sessionId,
        from: "requested",
        to: "provisioning",
        expectedGeneration: requested.generation,
        patch: { environmentId },
      });
      if (captured.state !== "provisioning") {
        throw new Error("Probe requires captured provisioning owner");
      }
      const globalConfig: OpenClawConfig = { ...individual, session: { scope: "global" } };
      setRuntimeConfigSnapshot(globalConfig, globalConfig);
      const globalWorktree = await managedWorktrees.createEmpty({
        name: "full-target-global",
        ownerKind: "session",
        ownerId: "global",
        runSetupScript: false,
        provisionIgnoredFiles: false,
      });
      await replaceSessionEntry(
        { agentId: "main", sessionKey: "global", storePath },
        {
          sessionId: "distinct-global-window",
          updatedAt: 2,
          lifecycleRevision: "global-window",
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          worktree: {
            id: globalWorktree.id,
            branch: globalWorktree.branch,
            repoRoot: globalWorktree.repoRoot,
          },
        },
      );
      if (scope === "individual") {
        setRuntimeConfigSnapshot(individual, individual);
      }
      const destroy = vi.fn(async () => {});
      const unexpected = async (): Promise<never> => {
        throw new Error("Unexpected external provider work");
      };
      const provider = {
        id: profile.provider,
        supportedExecutionModes: ["worker-turn"] as const,
        resolveAllocation: unexpected,
        provision: unexpected,
        inspect: async () => ({ status: "active" as const }),
        destroy,
      };
      const scheduler = createTestGatewayScheduler();
      const environments = createWorkerEnvironmentService({
        scheduler,
        store: environmentStore,
        getConfig: getRuntimeConfig,
        resolveProvider: (id) => (id === provider.id ? provider : undefined),
        prepareInstallation: unexpected,
        bootstrapWorker: unexpected,
        executeInference: unexpected,
        placementStore: createWorkerSessionPlacementGate(placements),
      });
      try {
        const runtime = createGatewayWorkerPlacementRuntime({
          scheduler,
          placements,
          environments,
          getCommittedRuntimeConfig: getRuntimeConfig,
          gatewayNamespace: "full-target-probe",
          cancelSessionWork: async () => {},
          revokeSessionAuthority: () => {},
          warn: () => {},
        });
        const replay = vi.fn(async () => {});
        let resultState: string | undefined;
        let admissionFailure: { name: string; message: string } | undefined;
        try {
          resultState = (await runtime.dispatchService.resumeProvisioning(captured, replay))?.state;
        } catch (error) {
          admissionFailure =
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "UnknownError", message: String(error) };
        }
        const current = placements.get(identity.sessionId);
        const original = loadExactSessionEntryReadOnly({ ...identity, storePath })?.entry;
        const global = loadExactSessionEntryReadOnly({
          agentId: "main",
          sessionKey: "global",
          storePath,
        })?.entry;
        const outcome = {
          scope,
          inherited,
          replayCalls: replay.mock.calls.length,
          result: resultState,
          admissionFailure,
          placement: current?.state,
          recoveryError: current?.recoveryError,
          environment: environments.get(environmentId)?.state,
          destroyCalls: destroy.mock.calls.length,
          originalSessionId: original?.sessionId,
          originalWorktreeId: original?.worktree?.id,
          globalSessionId: global?.sessionId,
          globalWorktreeId: global?.worktree?.id,
        };
        console.log("FULL_TARGET_PROBE", JSON.stringify(outcome));
        expect(admissionFailure, JSON.stringify(outcome)).toBeUndefined();
        expect(resultState).toBeUndefined();
        expect(original?.sessionId).toBe(identity.sessionId);
        expect(original?.worktree?.id).toBe(originalWorktree.id);
        expect(global?.sessionId).toBe("distinct-global-window");
        expect(global?.worktree?.id).toBe(globalWorktree.id);
        expect(replay, JSON.stringify(outcome)).toHaveBeenCalledOnce();
        expect(current?.state).toBe("provisioning");
        expect(destroy).not.toHaveBeenCalled();
      } finally {
        await environments.stop();
      }
    });
  },
);

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
