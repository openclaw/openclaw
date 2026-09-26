import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import * as processExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import { workerService } from "../server-methods/environments.test-support.js";
import { resolveRepositoryWorkspaceAccess } from "../server-methods/session-repository-workspace-access.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils-store.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import {
  createPlacementFailureActions,
  type WorkerDispatchEnvironmentService,
} from "./placement-dispatch-failure.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { createWorkerPlacementReclaim } from "./placement-reclaim.js";
import { placementTurnOwner, projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { SessionWorkspaceReservationBusyError } from "./placement-workspace-reservation.js";
import { createRepositoryWorkspaceMutationService } from "./repository-workspace-mutation.js";
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import {
  readSessionRepositoryArtifacts,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
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
  setupWorkerTurnLauncherTest,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
import {
  requireWorkspaceResultGit,
  withWorkspaceResultRefMutation,
} from "./workspace-result-git.js";
import {
  hasWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// This fixture clones a local Git origin; no GitHub identity is involved.
vi.mock("./worker-github-binding.js", () => ({
  prepareWorkerGitHubBinding: async () => undefined,
}));

describe("repository workspace result ownership", () => {
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

  async function fixture(executionMode: "worker-turn" | "remote-exec", runSetupScript = false) {
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
    const repository = store.create({
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
    const initialCheckpointRef = store.get(repository.workspaceId)!.checkpointRef;
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
    const finishTurn = (
      owned: Awaited<ReturnType<typeof beginTurn>>,
      publishAcceptedWorkspace?: () => Promise<void>,
    ) =>
      reconcileWorkspaceAfterTurn({
        ...owned,
        placements,
        workspaceOperations,
        workspace: { kind: "repository", repository: store.get(repository.workspaceId)! },
        transcriptTarget: sessionTarget,
        tunnel,
        publishAcceptedWorkspace,
      });
    const environments: WorkerDispatchEnvironmentService = {
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
      repository: store.get(repository.workspaceId)!,
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

  it.for(
    (["worker-turn", "remote-exec"] as const).flatMap((executionMode) =>
      (["ref-queue", "publication-metadata"] as const).flatMap((boundary) =>
        [false, true].map((drained) => ({ executionMode, boundary, drained })),
      ),
    ),
  )(
    "fences $executionMode editor checkpoint writes at $boundary (drained=$drained)",
    async ({ executionMode, boundary, drained }, { signal }) => {
      const f = await fixture(executionMode);
      const before = f.store.get(f.repository.workspaceId)!;
      const artifactRoot = f.store.artifactPath(before.workspaceId);
      const refs = () => requireWorkspaceResultGit(artifactRoot, ["show-ref"]);
      const beforeRefs = await refs();
      const commonDir = await fs.realpath(artifactRoot);
      const queueKey = process.platform === "win32" ? commonDir.toLowerCase() : commonDir;
      const payloadPrefix = path.join(os.tmpdir(), "openclaw-publication-payload-");
      const editorBytes = "saved by the real repository mutation service\n";
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const queueHeld = createDeferredCore();
      // Runner cancellation releases the real predecessor without a second timer.
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      let publicationMetadata: { raw: string; digest: string } | undefined;
      let observedBoundary = false;
      let resumes = 0;
      let assertMutationCurrent: (() => void) | undefined;
      let queueOwner: Promise<void> | undefined;
      let saving: Promise<{ ok: true; value: string } | { ok: false; error: unknown }> | undefined;
      // Observe real operations; no authority predicate or physical effect is mocked.
      const imports = vi.spyOn(processExec, "runExec");
      const writes = vi.spyOn(fs, "writeFile");
      const temporary = vi.spyOn(fs, "mkdtemp");
      const fastImports = () =>
        imports.mock.calls.filter(
          ([command, args]) =>
            command === "git" && args.includes(artifactRoot) && args.includes("fast-import"),
        ).length;
      const publicationWrites = () =>
        writes.mock.calls.filter(
          ([target]) => typeof target === "string" && target.startsWith(payloadPrefix),
        ).length;
      const candidates = async () =>
        (
          await requireWorkspaceResultGit(artifactRoot, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/openclaw/worker-result-candidates/",
          ])
        )
          .split("\n")
          .filter(Boolean);
      const quiesce = f.tunnel.quiesceWorkspace.bind(f.tunnel);
      vi.spyOn(f.tunnel, "quiesceWorkspace").mockImplementation(async (...args) => {
        const held = await quiesce(...args);
        return {
          ...held,
          resume: async () => {
            await held.resume();
            resumes++;
          },
        };
      });
      try {
        expect(await candidates()).toEqual([]);
        if (boundary === "ref-queue") {
          queueOwner = withWorkspaceResultRefMutation(artifactRoot, async () => {
            queueHeld.resolve();
            await release.promise;
          });
          await Promise.race([queueHeld.promise, queueOwner, entered.promise]);
          // Observe admission AFTER the real enqueue. The real ref owner above
          // still holds its predecessor; neither queue nor operation is replaced.
          const gitRefMutations = resolveGlobalSingleton<KeyedAsyncQueue>(
            Symbol.for("openclaw.gitRefMutations"),
            () => {
              throw new Error("Git ref queue not initialized");
            },
          );
          const enqueue = gitRefMutations.enqueue.bind(gitRefMutations);
          vi.spyOn(gitRefMutations, "enqueue").mockImplementation((key, task, hooks) => {
            const queued = enqueue(key, task, hooks);
            if (key === queueKey && !observedBoundary) {
              observedBoundary = true;
              entered.resolve();
            }
            return queued;
          });
        }
        const read = publicationSnapshot.readGitHubRepositoryPublicationMetadata;
        vi.spyOn(publicationSnapshot, "readGitHubRepositoryPublicationMetadata").mockImplementation(
          async (...args) => {
            const metadata = await read(...args);
            publicationMetadata = { raw: metadata.raw, digest: args[1] };
            if (boundary === "publication-metadata" && !observedBoundary) {
              observedBoundary = true;
              entered.resolve();
              await release.promise;
            }
            return metadata;
          },
        );
        const admittedClaims = vi.spyOn(placements, "claimWorkspaceMutationResult");
        saving = f.mutations
          .mutate({
            ...sessionTarget,
            assertCurrent: () => {},
            mutate: async (assertCurrent) => {
              assertMutationCurrent = assertCurrent;
              assertCurrent();
              await fs.writeFile(path.join(f.remote, "editor.txt"), editorBytes);
              return { changed: true, value: "saved" };
            },
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        const earlyOutcome = await Promise.race([entered.promise.then(() => undefined), saving]);
        if (earlyOutcome) {
          if (!earlyOutcome.ok) {
            throw earlyOutcome.error;
          }
          throw new Error("Editor save settled before its checkpoint boundary");
        }
        expect(observedBoundary).toBe(true);
        if (!assertMutationCurrent) {
          throw new Error("Repository mutation did not admit its editor operation");
        }
        expect(assertMutationCurrent).not.toThrow();
        expect(admittedClaims).toHaveBeenCalledTimes(1);
        const admission = admittedClaims.mock.results[0];
        if (admission?.type !== "return") {
          throw new Error("Repository mutation did not return its admitted claim");
        }
        const claim = admission.value;
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
        const pausedCandidates = await candidates();
        expect(pausedCandidates).toHaveLength(boundary === "publication-metadata" ? 1 : 0);
        if (boundary === "publication-metadata") {
          const raw = await readStagedWorkerWorkspaceResult(artifactRoot, pausedCandidates[0]!);
          expect(raw.current.baseCommit).toBe(before.baseCommit);
          expect(raw.changedEntries.map((entry) => entry.path)).toContain("editor.txt");
        }
        const importsBefore = fastImports();
        const writesBefore = publicationWrites();
        expect(importsBefore).toBe(boundary === "publication-metadata" ? 1 : 0);
        expect(writesBefore).toBe(0);
        expect(f.store.get(before.workspaceId)).toEqual(before);
        if (drained) {
          const draining = placements.startWorkspaceResultDrain(claim);
          expect(draining).toMatchObject({
            state: "draining",
            generation: claim.placementGeneration + 1,
          });
          expect(assertMutationCurrent).toThrow(
            "Repository workspace edit lost its exact session placement owner",
          );
        } else {
          expect(assertMutationCurrent).not.toThrow();
        }
        // Operation authority closes without physical worker shutdown or deletion
        // of the pending result that still owns eventual recovery.
        expect(f.ownerSignal.aborted).toBe(false);
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
        release.resolve();
        const outcome = await saving;
        await queueOwner;
        const remainingCandidates = await candidates();
        const after = f.store.get(before.workspaceId)!;
        const pending = placements.listPendingWorkspaceResults(SESSION_ID);
        // The intermediate copy is gone; only the real private import inputs exist.
        const importRoots: string[] = [];
        for (const [index, [prefix]] of temporary.mock.calls.entries()) {
          expect(prefix.startsWith(payloadPrefix)).toBe(false);
          const result = temporary.mock.results[index];
          if (
            result?.type === "return" &&
            path.basename(prefix).startsWith("openclaw-workspace-import-")
          ) {
            importRoots.push(String(await result.value));
          }
        }
        for (const importRoot of importRoots) {
          await expect(fs.stat(importRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        // Observe the real file-backed command rather than the retired buffered seam.
        for (const [command, args, options] of imports.mock.calls) {
          if (command === "git" && args.includes(artifactRoot) && args.includes("fast-import")) {
            expect(options).toMatchObject({ stdinFileDescriptor: expect.any(Number) });
          }
        }
        expect(importRoots).toHaveLength(drained ? 1 : 2);
        expect(remainingCandidates).toEqual([]);
        expect(resumes).toBe(1);
        expect(f.ownerSignal.aborted).toBe(false);
        expect(await fs.readFile(path.join(f.remote, "editor.txt"), "utf8")).toBe(editorBytes);
        if (drained) {
          expect(outcome).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining("lost its exact session placement owner") },
          });
          expect(fastImports()).toBe(importsBefore);
          expect(publicationWrites()).toBe(writesBefore);
          expect(after).toEqual(before);
          expect(await refs()).toBe(beforeRefs);
          expect(pending).toMatchObject([
            {
              claimId: claim.claimId,
              workspaceAcceptedAtMs: null,
              stagedResultRef: null,
              recoveryRequestedAtMs: expect.any(Number),
            },
          ]);
          expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
        } else {
          expect(outcome).toEqual({ ok: true, value: "saved" });
          expect(after.checkpointRef).not.toBe(before.checkpointRef);
          expect(fastImports()).toBe(2);
          expect(publicationWrites()).toBe(0);
          expect(publicationMetadata).toBeDefined();
          const expectedPublication = publicationMetadata!;
          await withSessionRepositoryCheckpoint(
            { workspaceId: before.workspaceId, includePublication: true },
            async (snapshot) => {
              expect(await fs.readFile(path.join(snapshot.stagingRoot, "editor.txt"), "utf8")).toBe(
                editorBytes,
              );
              expect(snapshot.publicationDigest).toBe(expectedPublication.digest);
              const publicationRoot = snapshot.publicationStagingRoot!;
              expect(await fs.readFile(path.join(publicationRoot, "snapshot.json"), "utf8")).toBe(
                expectedPublication.raw,
              );
              expect(await fs.readFile(path.join(publicationRoot, "binding.json"), "utf8")).toBe(
                JSON.stringify({
                  currentManifestRef: snapshot.currentManifestRef,
                  publicationDigest: expectedPublication.digest,
                }),
              );
              const sha = createHash("sha1")
                .update(`blob ${Buffer.byteLength(editorBytes)}\0${editorBytes}`)
                .digest("hex");
              expect(await fs.readFile(path.join(publicationRoot, "blobs", sha), "utf8")).toBe(
                editorBytes,
              );
            },
          );
          expect(pending).toEqual([]);
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        }
      } finally {
        release.resolve();
        await Promise.allSettled([saving, queueOwner]);
        signal.removeEventListener("abort", unblock);
        vi.restoreAllMocks();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "keeps %s editor staging SQL constant across publication blobs and unchanged saves untouched",
    async (executionMode) => {
      const f = await fixture(executionMode);
      const context = createGatewayRequestContext(makeContextParams());
      context.workerSessionPlacementService = placements;
      context.workerEnvironmentService = { ...workerService(), ...f.environments };
      context.workerRepositoryWorkspaceMutationService = f.mutations;
      const authorize = vi.fn();
      const stage = checkpoints.stageSessionRepositoryCheckpoint;
      const stageCosts: Array<{ callbacks: number; statements: number }> = [];
      for (const blobCount of [1, 8]) {
        authorize.mockClear();
        // Fixed raw inventory/byte count; only publication deduplication varies.
        const content = (index: number) => `sample-${blobCount}-blob-${index % blobCount}\n`;
        for (let index = 0; index < 8; index++) {
          await fs.writeFile(path.join(f.remote, `edit-${index}.txt`), content(index));
        }
        await fs.writeFile(path.join(f.remote, "edit-0.txt"), "before\n");
        const access = resolveRepositoryWorkspaceAccess(
          loadGatewaySessionEntryReadOnly(sessionTarget.sessionKey),
          context,
        );
        if (access?.kind !== "active") {
          throw new Error("Expected live repository editor access");
        }
        const sql = observeHostDataSql();
        const count = () => ({
          callbacks: authorize.mock.calls.length,
          statements: sql.calls
            .slice(1)
            .reduce((total, called) => total + called.mock.calls.length, 0),
        });
        const observer = vi
          .spyOn(checkpoints, "stageSessionRepositoryCheckpoint")
          .mockImplementation(async (params) => {
            const before = count();
            const prepared = await stage(params);
            const after = count();
            stageCosts.push({
              callbacks: after.callbacks - before.callbacks,
              statements: after.statements - before.statements,
            });
            return prepared;
          });
        try {
          const saved = await access.inspect(
            "set",
            {
              path: "edit-0.txt",
              content: content(0),
              expectedHash: createHash("sha256").update("before\n").digest("hex"),
            },
            authorize,
          );
          expect(saved).toMatchObject({ status: "updated" });
          console.info("editor-stage-sql", executionMode, blobCount, stageCosts.at(-1), count());
        } finally {
          observer.mockRestore();
          sql.restore();
        }
        await withSessionRepositoryCheckpoint(
          { workspaceId: f.repository.workspaceId, includePublication: true },
          async (snapshot) => {
            expect(snapshot.changedEntries).toHaveLength(8);
            const blobs = await fs.readdir(path.join(snapshot.publicationStagingRoot!, "blobs"));
            expect(blobs).toHaveLength(blobCount);
            expect(await fs.readFile(path.join(snapshot.stagingRoot, "edit-0.txt"), "utf8")).toBe(
              content(0),
            );
            expect(placements.get(SESSION_ID)?.workspaceBaseManifestRef).toBe(
              snapshot.currentManifestRef,
            );
          },
        );
      }
      expect(stageCosts).toHaveLength(2);
      expect(stageCosts[0]!.callbacks).toBeGreaterThan(0);
      expect(stageCosts[0]!.statements).toBeGreaterThan(0);
      expect(stageCosts[1]).toEqual(stageCosts[0]);
      const accepted = f.store.get(f.repository.workspaceId);
      await expect(
        f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async () => ({ changed: false, value: "unchanged" }),
        }),
      ).resolves.toBe("unchanged");
      expect(f.store.get(f.repository.workspaceId)).toEqual(accepted);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "recovers unknown %s editor writes through pending result custody",
    async (executionMode) => {
      const f = await fixture(executionMode);
      await expect(
        f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async () => {
            await fs.writeFile(
              path.join(f.remote, "uncertain.txt"),
              "write completed before transport loss\n",
            );
            throw new Error("editor transport lost the acknowledgement");
          },
        }),
      ).rejects.toThrow("lost the acknowledgement");
      expect(placements.listPendingWorkspaceResults()).toMatchObject([
        {
          workspaceAcceptedAtMs: null,
          recoveryRequestedAtMs: expect.any(Number),
        },
      ]);
      await recoverPendingWorkspaceResults(
        {
          placements,
          environments: f.environments,
          failure: createPlacementFailureActions({ placements, environments: f.environments }),
          workspaceOperations: f.workspaceOperations,
          ...createWorkerWorkspaceRecoveryFixture({ resolveWorkspace: f.resolveWorkspace }),
        },
        false,
      );
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      const checkpoint = await readArtifact(f.repository.workspaceId, "uncertain.txt");
      expect(checkpoint.preview).toEqual(
        new Uint8Array(Buffer.from("write completed before transport loss\n")),
      );
    },
  );

  it.each(["publisher", "editor"] as const)(
    "excludes competing publication and editor writes when the %s acquires first",
    async (firstOwner) => {
      const f = await fixture("worker-turn");
      const competing = vi.fn(async () => ({ changed: false, value: "unexpected" }));
      if (firstOwner === "publisher") {
        await placements.withRepositoryWorkspaceReservation(sessionTarget, async (assertOwned) => {
          await expect(
            f.mutations.mutate({
              ...sessionTarget,
              assertCurrent: () => {},
              mutate: competing,
            }),
          ).rejects.toThrow("being published");
          assertOwned();
        });
      } else {
        await f.mutations.mutate({
          ...sessionTarget,
          assertCurrent: () => {},
          mutate: async (assertCurrent) => {
            await expect(
              placements.withRepositoryWorkspaceReservation(sessionTarget, competing),
            ).rejects.toBeInstanceOf(SessionWorkspaceReservationBusyError);
            assertCurrent();
            return { changed: false, value: "unchanged" };
          },
        });
      }
      expect(competing).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("preserves editor result custody when capture returns without durable acceptance", async () => {
    const f = await fixture("worker-turn");
    vi.spyOn(f.tunnel, "reconcileWorkspace").mockResolvedValue({
      manifestRef: placements.get(SESSION_ID)!.workspaceBaseManifestRef!,
      changed: true,
      verifyStable: async () => {},
      verifyLocalStable: async () => {},
    });
    await expect(
      f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "unaccepted.txt"), "save requires a checkpoint\n");
          return { changed: true, value: "saved" };
        },
      }),
    ).rejects.toThrow("not durably accepted");
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(f.initialCheckpointRef);
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      { workspaceAcceptedAtMs: null, recoveryRequestedAtMs: expect.any(Number) },
    ]);
  });

  it("rejects editor writes during an admitted turn and fences writes if their placement starts draining", async () => {
    const f = await fixture("worker-turn");
    const activeTurn = await f.beginTurn("running-turn");
    const mutate = vi.fn(async () => ({ changed: true, value: "unexpected" }));
    await expect(
      f.mutations.mutate({ ...sessionTarget, assertCurrent: () => {}, mutate }),
    ).rejects.toThrow("active turn claim");
    expect(mutate).not.toHaveBeenCalled();
    placements.acceptWorkspaceResult(activeTurn.turnClaim);
    placements.completeWorkspaceResultAndReleaseTurn(activeTurn.turnClaim);

    await expect(
      f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "interrupted.txt"), "must remain recoverable\n");
          expect(() =>
            placements.startDrain({
              sessionId: SESSION_ID,
              environmentId: activeTurn.placement.environmentId,
              ownerEpoch: activeTurn.placement.activeOwnerEpoch,
              expectedGeneration: activeTurn.placement.generation,
            }),
          ).toThrow("pending cloud workspace result");
          const claim = projectWorkerSessionTurnClaim(placements.get(SESSION_ID)!);
          expect(claim).toBeDefined();
          placements.startWorkspaceResultDrain(claim!);
          return { changed: true, value: "unaccepted" };
        },
      }),
    ).rejects.toThrow("lost its exact session placement owner");
    expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(f.initialCheckpointRef);
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      {
        recoveryRequestedAtMs: expect.any(Number),
        workspaceAcceptedAtMs: null,
      },
    ]);
  });

  it.each(["worker-turn", "remote-exec"] as const)(
    "retains setup and cumulative %s changes through turns, editor saves, and Stop",
    async (executionMode) => {
      const f = await fixture(executionMode, true);
      const pinned = f.store.get(f.repository.workspaceId)!;
      expect(pinned.manifestHash).not.toBe(pinned.baseManifestHash);
      await fs.writeFile(path.join(f.remote, "first.txt"), "first turn\n");
      const first = await f.beginTurn("first");
      await f.finishTurn(first);
      await fs.writeFile(path.join(f.remote, "second.txt"), "second turn\n");
      await f.finishTurn(await f.beginTurn("second"));
      await f.finishTurn(await f.beginTurn("read-only"));
      await f.mutations.mutate({
        ...sessionTarget,
        assertCurrent: () => {},
        mutate: async () => {
          await fs.writeFile(path.join(f.remote, "editor.txt"), "editor save\n");
          return { changed: true, value: undefined };
        },
      });
      await f.stop(sessionTarget);
      expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
      const expected = new Map([
        ["editor.txt", "editor save\n"],
        ["first.txt", "first turn\n"],
        ["second.txt", "second turn\n"],
        ["setup.txt", "prepared\n"],
      ]);
      await withSessionRepositoryCheckpoint(
        { workspaceId: f.repository.workspaceId },
        async (snapshot) => {
          expect(snapshot.changedEntries.map((entry) => entry.path)).toEqual([
            "editor.txt",
            "first.txt",
            "second.txt",
            "setup.txt",
          ]);
          for (const entry of snapshot.changedEntries) {
            expect(await fs.readFile(path.join(snapshot.stagingRoot, entry.path), "utf8")).toBe(
              expected.get(entry.path),
            );
          }
          expect(snapshot.baseManifestRef).toBe(pinned.baseManifestHash);
        },
      );
      expect(f.store.get(f.repository.workspaceId)?.baseManifestHash).toBe(pinned.baseManifestHash);
      const artifactRoot = f.store.artifactPath(f.repository.workspaceId);
      expect(
        await requireWorkspaceResultGit(artifactRoot, ["rev-parse", "--is-bare-repository"]),
      ).toBe("true");
      await expect(fs.stat(path.join(artifactRoot, "first.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await hasWorkerWorkspaceResultRef({
          root: artifactRoot,
          stagedResultRef: workerWorkspaceResultRef(first.turnClaim.claimId),
        }),
      ).toBe(true);
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("binds a staged repository result to its exact immutable session owner", async () => {
    const f = await fixture("worker-turn");
    const { turnClaim } = await f.beginTurn("source-binding");
    const foreign = f.store.create({
      agentId: sessionTarget.agentId,
      sessionKey: "agent:main:other-repository",
      url: f.repository.url,
      assertCurrent: () => {},
    });
    const ref = workerWorkspaceResultRef(turnClaim.claimId);
    expect(() =>
      placements.recordStagedWorkspaceResult(turnClaim, ref, foreign.workspaceId),
    ).toThrow("repository owner changed");
    expect(placements.listPendingWorkspaceResults()).toMatchObject([{ stagedResultRef: null }]);
    placements.recordStagedWorkspaceResult(turnClaim, ref, f.repository.workspaceId);
    expect(() => placements.recordStagedWorkspaceResult(turnClaim, ref)).toThrow(
      "result ref changed",
    );
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      {
        stagedResultRef: ref,
        repositoryWorkspaceId: f.repository.workspaceId,
      },
    ]);
  });

  it.each([
    { executionMode: "worker-turn", phase: "pending-pointer", materialized: false },
    { executionMode: "remote-exec", phase: "pending-pointer", materialized: false },
    { executionMode: "worker-turn", phase: "Gateway materialization", materialized: true },
    { executionMode: "remote-exec", phase: "Gateway materialization", materialized: true },
  ] as const)(
    "recovers an accepted $executionMode checkpoint after restart during $phase",
    async ({ executionMode, materialized }) => {
      const f = await fixture(executionMode);
      await fs.writeFile(path.join(f.remote, "survives.txt"), "durable before restart\n");
      const owned = await f.beginTurn("interrupted", !materialized);
      const destination = path.join(root, "materialized-worktree");
      if (materialized) {
        placements.beginPlacementMove({
          sessionId: SESSION_ID,
          source: {
            generation: owned.placement.generation,
            environmentId: owned.placement.environmentId,
            ownerEpoch: owned.placement.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
        });
        placements.markWorkspaceResultPending(owned.turnClaim);
        await expect(
          f.finishTurn(owned, async () => {
            await fs.mkdir(destination);
            await fs.copyFile(
              path.join(f.remote, "survives.txt"),
              path.join(destination, "survives.txt"),
            );
            await patchSessionEntryCore(
              sessionTarget,
              (entry) => ({ ...entry, repositoryWorkspaceId: undefined }),
              { replaceEntry: true },
            );
            expect(loadSessionEntry(sessionTarget)?.repositoryWorkspaceId).toBeUndefined();
            throw new Error("process exited after Gateway materialization");
          }),
        ).rejects.toThrow("process exited after Gateway materialization");
      } else {
        const record = vi
          .spyOn(placements, "recordStagedWorkspaceResult")
          .mockImplementationOnce(() => {
            throw new Error("process exited before pending pointer");
          });
        await expect(f.finishTurn(owned)).rejects.toThrow("process exited before pending pointer");
        record.mockRestore();
      }
      const checkpointRef = workerWorkspaceResultRef(owned.turnClaim.claimId);
      expect(f.store.get(f.repository.workspaceId)?.checkpointRef).toBe(checkpointRef);
      expect(placements.listPendingWorkspaceResults()).toMatchObject([
        materialized
          ? {
              stagedResultRef: checkpointRef,
              repositoryWorkspaceId: f.repository.workspaceId,
              workspaceAcceptedAtMs: expect.any(Number),
            }
          : { stagedResultRef: null, workspaceAcceptedAtMs: null },
      ]);
      await fs.rm(f.remote, { recursive: true });
      if (materialized) {
        const database = openOpenClawStateDatabase();
        executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<Pick<DB, "worker_environments">>(database.db)
            .deleteFrom("worker_environments")
            .where("environment_id", "=", owned.placement.environmentId),
        );
      }
      await closeStateDatabaseForTest();
      const restarted = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase(),
      });
      const environments: WorkerDispatchEnvironmentService = {
        ...f.environments,
        get: () => undefined,
        startTunnel: vi.fn(async () => {
          throw new Error("worker is gone");
        }),
      };
      const reportWorkspaceResultRecoveryFailure = vi.fn(async () => {});
      await recoverPendingWorkspaceResults(
        {
          placements: restarted,
          environments,
          failure: createPlacementFailureActions({ placements: restarted, environments }),
          workspaceOperations: f.workspaceOperations,
          ...createWorkerWorkspaceRecoveryFixture({
            resolveWorkspace: async () =>
              materialized
                ? { kind: "local", path: destination }
                : { kind: "repository", repository: f.store.get(f.repository.workspaceId)! },
            reportFailure: reportWorkspaceResultRecoveryFailure,
          }),
        },
        true,
      );
      expect(reportWorkspaceResultRecoveryFailure).not.toHaveBeenCalled();
      expect(restarted.listPendingWorkspaceResults()).toEqual([]);
      expect(restarted.get(SESSION_ID)).toMatchObject({
        state: materialized ? "local" : "reclaimed",
        turnClaim: null,
      });
      expect(environments.startTunnel).not.toHaveBeenCalled();
      const saved = await readArtifact(f.repository.workspaceId, "survives.txt");
      expect(saved.preview).toEqual(new Uint8Array(Buffer.from("durable before restart\n")));
    },
  );
});
