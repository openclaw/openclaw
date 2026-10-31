import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as sessionEntries from "../../config/sessions/session-accessor.js";
import * as cloneRuntime from "../../projects/project-clone-runtime.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { createGatewayWorkerPlacementMoveBarrier } from "../server-worker-placement-move-barrier.js";
import { createGatewayWorkerPlacementReclaimBarriers } from "../server-worker-placement-reclaim.js";
import {
  createWorkerWorkspaceRecoveryPreparer,
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionTarget,
} from "../server-worker-placement-session-target.js";
import { createRepositoryGatewayMovePreparation } from "../session-repository-materialization.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentService } from "./service.js";
import { createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { SESSION_ID, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

// mock-isolation: Git and node transfer use a local origin, never a live GitHub identity.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));
const { fixture } = useRepositoryWorkspaceResultFixture();
const url = "https://github.com/synthetic/disk-move-fixture.git";

it.each([
  "complete",
  "intent",
  "imported",
  "before-export",
  "captured",
  "bound",
  "before-cleanup",
  "after-cleanup",
  "released",
  "reconciling",
  "revoked",
  "incognito",
  "incognito-revoked",
] as const)("sessions.move preserves disk custody through %s", async (scenario) => {
  const incognito = scenario.startsWith("incognito");
  const boundary =
    scenario === "incognito" ? "complete" : scenario === "incognito-revoked" ? "revoked" : scenario;
  const f = await fixture("remote-exec", false, incognito, url);
  const repository = await f.bindDisk();
  assert(repository.diskAuthority);
  await registerClonedProjectRegistry({ path: f.origin, name: "Fixture", originUrl: url });
  vi.spyOn(cloneRuntime, "readProjectCheckoutRemoteHead").mockResolvedValue(undefined);
  await f.write("committed.txt", "private disk history\n");
  await requireWorkspaceResultGit(f.remote, ["add", "committed.txt"]);
  await requireWorkspaceResultGit(f.remote, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "private disk commit",
  ]);
  const head = await requireWorkspaceResultGit(f.remote, ["rev-parse", "HEAD"]);
  await f.write("only-on-disk.txt", "fresh disk result\n");
  const records = await createWorkerEnvironmentStore({ database: openOpenClawStateDatabase() });
  const original = records.get(repository.diskAuthority.environmentId)!;
  writePlacementEnvironmentFixture(openOpenClawStateDatabase(), {
    ...original,
    nodeDeviceId: "repository-node-fixture",
    sharedHost: false,
  });
  const destroy = vi.fn(
    async (lease: Parameters<ReturnType<typeof createProvider>["destroy"]>[0]) => {
      lease.assertCurrent?.();
      expect(lease.resourceReceipt).toEqual(repository.diskAuthority!.resourceReceipt);
      const entry = sessionEntries.loadSessionEntry(sessionTarget)!;
      expect(entry.repositoryWorkspaceId).toBeUndefined();
      expect(await fs.readFile(path.join(entry.spawnedCwd!, "only-on-disk.txt"), "utf8")).toBe(
        "fresh disk result\n",
      );
      expect((await f.store.get(repository.workspaceId))?.diskAuthority).toBeUndefined();
      await fs.rm(f.remote, { recursive: true });
    },
  );
  const provider = createProvider({
    id: original.providerId,
    supportsResourceReceipts: true,
    inspect: async () => ({
      status: "active",
      resourceReceipt: repository.diskAuthority!.resourceReceipt,
    }),
    destroy,
  });
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store: records,
    getConfig: getRuntimeConfig,
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    prepareInstallation: async () => {
      throw new Error("unexpected installation");
    },
    bootstrapWorker: async () => {
      throw new Error("unexpected bootstrap");
    },
  });
  // Only the external node transport is supplied by the local real Git/HTTP fixture.
  vi.spyOn(environments, "startTunnel").mockImplementation(f.environments.startTunnel);
  const quiesce = vi.spyOn(f.tunnel, "quiesceWorkspace");
  const interruption = new Error("interrupted at " + boundary);
  if (boundary === "before-export") {
    quiesce.mockRejectedValueOnce(interruption);
  }
  if (boundary === "captured" || boundary === "revoked") {
    const record = f.placements.recordStagedWorkspaceResult.bind(f.placements);
    vi.spyOn(f.placements, "recordStagedWorkspaceResult").mockImplementationOnce(
      async (...args) => {
        const result = await record(...args);
        if (boundary === "revoked") {
          await sessionEntries.upsertSessionEntryCore(sessionTarget, {
            lifecycleRevision: "successor",
          });
          return result;
        }
        throw interruption;
      },
    );
  }
  if (boundary === "imported") {
    // Simulate process loss after import: no session commit and no finally rollback.
    vi.spyOn(sessionEntries, "patchSessionEntryCore").mockRejectedValueOnce(interruption);
    vi.spyOn(managedWorktrees, "rollbackPreparation").mockResolvedValueOnce(undefined);
  }
  if (boundary === "bound") {
    const patch = sessionEntries.patchSessionEntryCore;
    vi.spyOn(sessionEntries, "patchSessionEntryCore").mockImplementationOnce(async (...args) => {
      await patch(...args);
      throw interruption;
    });
  }
  if (boundary === "before-cleanup" || boundary === "after-cleanup") {
    const reclaim = environments.reclaim;
    vi.spyOn(environments, "reclaim").mockImplementationOnce(async (...args) => {
      if (boundary === "after-cleanup") {
        await reclaim(...args);
      }
      throw interruption;
    });
  }
  if (boundary === "released") {
    const release = f.placements.completeWorkspaceResultAndReleaseTurn.bind(f.placements);
    vi.spyOn(f.placements, "completeWorkspaceResultAndReleaseTurn").mockImplementationOnce(
      async (...args) => {
        await release(...args);
        throw interruption;
      },
    );
  }
  if (boundary === "reconciling") {
    const reconcile = f.placements.startReconcile;
    vi.spyOn(f.placements, "startReconcile").mockImplementationOnce(async (...args) => {
      await reconcile(...args);
      throw interruption;
    });
  }
  const resolveWorkspace = async () => {
    using resolved = await resolveWorkerPlacementSessionTarget({
      sessionRuntime: await loadWorkerPlacementSessionRuntimeModule(),
      config: getRuntimeConfig(),
      ...sessionTarget,
      errorMessage: "fixture workspace changed",
    });
    return resolved.workspace;
  };
  let interruptedIntent = false;
  const makeOptions = (placements: typeof f.placements) => {
    const barriers = createGatewayWorkerPlacementReclaimBarriers({
      placements,
      loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
      cancelSessionWork: async ({ assertCurrent }) => assertCurrent(),
      revokeSessionAuthority() {},
    });
    return {
      ...barriers,
      environmentService: environments,
      resolveWorkspace,
      prepareGatewayMove: createRepositoryGatewayMovePreparation({
        placements,
        environments,
        getConfig: getRuntimeConfig,
      }),
      runMoveBarrier: async (
        request: Parameters<ReturnType<typeof createGatewayWorkerPlacementMoveBarrier>>[0],
      ) => {
        const begun = await createGatewayWorkerPlacementMoveBarrier({
          placements,
          loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
          revokeSessionAuthority() {},
        })(request);
        if (boundary === "intent" && !interruptedIntent) {
          interruptedIntent = true;
          throw interruption;
        }
        return begun;
      },
      withPreparedRecovery: createWorkerWorkspaceRecoveryPreparer({
        loadSessionRuntime: loadWorkerPlacementSessionRuntimeModule,
        getConfig: getRuntimeConfig,
      }),
    };
  };
  const options = makeOptions(f.placements);
  const h = await createHarness(openOpenClawStateDatabase(), f.placements, options);
  const active = f.placements.get(SESSION_ID)!;
  try {
    const respond = await sendAuthorizationRequest(
      "sessions.move",
      {
        key: sessionTarget.sessionKey,
        expected: {
          generation: active.generation,
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
        target: { kind: "gateway" },
      },
      {
        scopes: ["operator.admin"],
        context: {
          getRuntimeConfig,
          workerPlacementDispatchService: h.service,
          workerSessionPlacementService: f.placements,
          workerEnvironmentService: environments,
          broadcast: vi.fn(),
        },
      },
    );
    if (boundary === "complete") {
      expect(respond.mock.calls).toEqual([
        [
          true,
          expect.objectContaining({ placement: expect.objectContaining({ state: "local" }) }),
          undefined,
        ],
      ]);
    } else {
      expect(respond.mock.calls).toEqual([
        [
          false,
          undefined,
          expect.objectContaining({
            message: expect.stringContaining(boundary === "revoked" ? "changed" : "interrupted at"),
          }),
        ],
      ]);
      if (
        ["intent", "imported", "before-export", "captured", "bound", "revoked"].includes(boundary)
      ) {
        expect(destroy).not.toHaveBeenCalled();
        expect((await f.store.get(repository.workspaceId))?.diskAuthority).toEqual(
          repository.diskAuthority,
        );
        expect(await fs.readFile(path.join(f.remote, "only-on-disk.txt"), "utf8")).toBe(
          "fresh disk result\n",
        );
      }
      if (boundary === "revoked") {
        return;
      }
      const previousCaptures = quiesce.mock.calls.length;
      const restartedStore = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      await restartedStore.clearLocalTurnClaimsAfterRestartAsync();
      const restarted = await createHarness(
        openOpenClawStateDatabase(),
        restartedStore,
        makeOptions(restartedStore),
      );
      await restarted.service.reconcileActive(repository.diskAuthority.environmentId);
      if (
        ["bound", "before-cleanup", "after-cleanup", "released", "reconciling"].includes(boundary)
      ) {
        expect(quiesce).toHaveBeenCalledTimes(previousCaptures);
      }
    }
    expect(
      await f.placements.getAsync(SESSION_ID),
      JSON.stringify(await sessionEntries.loadTranscriptEvents(sessionTarget)),
    ).toMatchObject({
      state: "local",
      turnClaim: null,
    });
    expect(await f.placements.getPlacementMoveAsync(SESSION_ID)).toBeUndefined();
    expect(await f.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    const local = sessionEntries.loadSessionEntry(sessionTarget)!;
    expect(local.repositoryWorkspaceId).toBeUndefined();
    expect(await fs.readFile(path.join(local.spawnedCwd!, "only-on-disk.txt"), "utf8")).toBe(
      "fresh disk result\n",
    );
    expect(await requireWorkspaceResultGit(local.spawnedCwd!, ["rev-parse", "HEAD"])).toBe(head);
    expect((await f.store.get(repository.workspaceId))?.diskAuthority).toBeUndefined();
    expect(destroy).toHaveBeenCalledOnce();
    expect(records.get(original.environmentId)?.state).toBe("destroyed");
  } finally {
    await environments.stop();
    await records.close();
  }
});
