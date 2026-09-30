import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import * as processExec from "../../process/exec.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import type { WorkerDispatchEnvironmentService } from "./placement-dispatch-failure.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import { placementTurnOwner } from "./placement-record.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import { readSessionRepositoryArtifacts } from "./session-repository-checkpoints.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  credential,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  placements,
  root,
  seedActivePlacement,
  SESSION_ID,
  sessionTarget,
  setWorkerTurnSessionTarget,
  setupWorkerTurnLauncherTest,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";

export function useRepositoryWorkspaceResultFixture() {
  const seedDirs = useAutoCleanupTempDirTracker(afterAll);
  const originSeeds = new Map<boolean, string>();
  let closeNode: (() => Promise<void>) | undefined;
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    try {
      await closeNode?.();
    } finally {
      closeNode = undefined;
      await cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
    }
  });
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  const readArtifact = (workspaceId: string, previewPath: string) =>
    readSessionRepositoryArtifacts({ workspaceId, previewPath, assertCurrent: () => {} });

  async function initializeOriginSeed(origin: string, runSetupScript: boolean) {
    if (runSetupScript) {
      await fs.mkdir(path.join(origin, ".openclaw"));
      await fs.writeFile(
        path.join(origin, ".openclaw", "worktree-setup.sh"),
        "#!/bin/sh\nprintf 'prepared\\n' > setup.txt\n",
        { mode: 0o755 },
      );
    }
    const git = async (...args: string[]) => {
      const result = await processExec.runCommandWithTimeout(["git", "-C", origin, ...args], {
        timeoutMs: 10_000,
        baseEnv: {
          PATH: process.env.PATH,
          HOME: origin,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(result.code, result.stderr).toBe(0);
    };
    await git("init", "--quiet");
    await git("add", ".");
    await git(
      "-c",
      "user.name=Repository Test",
      "-c",
      "user.email=repository@example.invalid",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "base",
    );
  }

  async function fixture(
    executionMode: "worker-turn" | "remote-exec",
    runSetupScript = false,
    incognito = false,
  ) {
    if (incognito) {
      setWorkerTurnSessionTarget({
        ...sessionTarget,
        sessionKey: "agent:main:dashboard:incognito-editor",
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: sessionTarget.agentId }),
      });
    }
    setRuntimeConfigSnapshot({ session: { store: sessionTarget.storePath } });
    let seed = originSeeds.get(runSetupScript);
    if (!seed) {
      seed = seedDirs.make("openclaw-repository-result-seed-");
      await initializeOriginSeed(seed, runSetupScript);
      originSeeds.set(runSetupScript, seed);
    }
    const origin = path.join(root, "origin");
    // Only pristine source bytes are shared; checkpoints and Git refs stay case-owned.
    await fs.cp(seed, origin, { recursive: true });
    const store = getSessionRepositoryWorkspaceStore();
    const repository = await store.create({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      url: pathToFileURL(origin).href,
      runSetupScript,
      assertCurrent: () => {},
    });
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
      repositoryWorkspaceId: repository.workspaceId,
      ...(incognito ? { incognito: true } : {}),
    });
    const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
    const service = createNodeWorkspaceTransferService({
      temporaryRoot: path.join(root, "transfers"),
      getOwner: () => ({ credential: credential(), environment: attachedEnvironment() }),
    });
    const server = await startNodeWorkspaceTransferTestServer(service);
    closeNode = async () => {
      await server.close();
      await service.closeAll();
    };
    const home = path.join(root, "node-home");
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "node-host"),
      env: { PATH: process.env.PATH, HOME: home },
    });
    const ownerSignal = new AbortController().signal;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      stop: vi.fn(),
      ...createNodeWorkerWorkspaceActions({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        ownerSignal,
        isOwnerCurrent: () => true,
        workspaceTransfer: service,
        runWorkspaceCommand: async (command) =>
          await runtime.exec(
            {
              gatewayNamespace: "gateway-repository-results",
              environmentId: ENVIRONMENT_ID,
              sessionId: SESSION_ID,
              generation: OWNER_EPOCH,
              ...command,
              argv: [...command.argv],
            },
            ownerSignal,
            { url: server.gatewayUrl },
          ),
      }),
    };
    const synced = await syncSessionRepositoryWorkspace({
      ...sessionTarget,
      repository,
      tunnel,
      generation: 1,
      runSetupScript,
      assertCurrent: () => {},
    });
    const remote = synced.remoteWorkspaceDir;
    const initialCheckpointRef = (await store.get(repository.workspaceId))!.checkpointRef;
    await seedActivePlacement(executionMode, remote, synced.manifestRef);
    const beginTurn = async (claimId: string, markResultPending = true) => {
      const placement = placements.get(SESSION_ID);
      if (placement?.state !== "active") {
        throw new Error("expected an active repository placement");
      }
      const turnClaim = await placements.claimTurn({
        ...sessionTarget,
        claimId,
        runId: claimId,
        owner: placementTurnOwner(placement),
      });
      if (markResultPending) {
        placements.markWorkspaceResultPending(turnClaim);
      }
      return { placement, turnClaim };
    };
    const finishTurn = async (
      owned: Awaited<ReturnType<typeof beginTurn>>,
      publishAcceptedWorkspace?: () => Promise<void>,
    ) =>
      reconcileWorkspaceAfterTurn({
        ...owned,
        placements,
        workspaceOperations,
        workspace: { kind: "repository", repository: (await store.get(repository.workspaceId))! },
        transcriptTarget: sessionTarget,
        tunnel,
        publishAcceptedWorkspace,
      });
    const environments: WorkerDispatchEnvironmentService = {
      fenceWorkerTurnForRecovery: () => {
        throw new Error("Repository result fixture does not synthesize startup claims");
      },
      prepareProjectIntent: async () => {
        throw new Error("unexpected local-project preparation");
      },
      assertPreparedIntentCurrent: vi.fn(),
      getPreparedCandidates: () => [],
      schedulePreparedRefill: vi.fn(),
      bindPreparedWorkspace: async () => {
        throw new Error("unexpected prepared binding");
      },
      get: () => attachedEnvironment(),
      createWithRequest: vi.fn(async () => attachedEnvironment()),
      attachSession: vi.fn(async () => credential()),
      destroy: vi.fn(async () => attachedEnvironment()),
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      reconcileEnvironment: vi.fn(async () => {}),
      reconcileOnce: vi.fn(async () => {}),
      supportsProviderExecutionMode: () => true,
    };
    const resolveWorkspace = async () => ({
      kind: "repository" as const,
      repository: (await store.get(repository.workspaceId))!,
    });
    const mutations = createRepositoryWorkspaceMutationService({
      placements,
      environments,
      resolveWorkspace,
      workspaceOperations,
    });
    const stop = createWorkerPlacementReclaim({
      placements,
      environments,
      workspaceOperations,
      runReclaimBarrier: async ({ begin, reclaim }) =>
        await reclaim(await resolveWorkspace(), begin()),
      withPreparedRecovery: createWorkerWorkspaceRecoveryFixture({ resolveWorkspace })
        .withPreparedRecovery,
    });
    return {
      remote,
      store,
      repository,
      initialCheckpointRef,
      beginTurn,
      finishTurn,
      workspaceOperations,
      mutations,
      stop,
      environments,
      resolveWorkspace,
      tunnel,
      ownerSignal,
    };
  }

  return { fixture, readArtifact };
}
