import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import * as processExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import { workerService } from "../server-methods/environments.test-support.js";
import { resolveRepositoryWorkspaceAccess } from "../server-methods/session-repository-workspace-access.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import {
  createPlacementFailureActions,
  type WorkerDispatchEnvironmentService,
} from "./placement-dispatch-failure.js";
import { recoverPendingWorkspaceResults } from "./placement-dispatch-pending-results.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { SessionWorkspaceReservationBusyError } from "./placement-workspace-reservation.kernel.js";
import * as checkpoints from "./session-repository-checkpoints.js";
import { withSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import {
  placements,
  root,
  SESSION_ID,
  sessionTarget,
} from "./worker-turn-launcher.test-support.js";
import {
  createWorkerWorkspaceRecoveryFixture,
  expectWorkspaceFiles,
} from "./workspace-recovery.test-support.js";
import {
  requireWorkspaceResultGit,
  withWorkspaceResultRefMutation,
} from "./workspace-result-git.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";
import {
  hasWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

// mock-isolation: This fixture clones a local Git origin without GitHub credentials.
vi.mock("./repository-github-identity.js", () => ({
  prepareRepositoryGitHubIdentity: async (_agentId: string, assertCurrent: () => void) => ({
    token: undefined,
    assertSelected: assertCurrent,
    start: async (start: () => Promise<unknown>) => await start(),
  }),
}));

describe("repository workspace result ownership", () => {
  const { fixture, readArtifact } = useRepositoryWorkspaceResultFixture();
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function editorContext(f: Fixture) {
    const context = createGatewayRequestContext(makeContextParams());
    context.workerSessionPlacementService = placements;
    context.workerEnvironmentService = { ...workerService(), ...f.environments };
    return context;
  }
  async function recover(
    f: Fixture,
    store = placements,
    environments = f.environments,
    recovery = createWorkerWorkspaceRecoveryFixture({ resolveWorkspace: f.resolveWorkspace }),
  ) {
    await recoverPendingWorkspaceResults(
      {
        placements: store,
        environments,
        failure: createPlacementFailureActions({ placements: store, environments }),
        workspaceOperations: f.workspaceOperations,
        ...recovery,
      },
      await store.readProjection([SESSION_ID], { current: true }),
    );
  }

  it("refuses repository effects after a committed session change without host SQL", async () => {
    const f = await fixture("worker-turn");
    const context = editorContext(f);
    const loaded = await loadGatewaySessionEntryReadOnlyInWorker({
      cfg: context.getRuntimeConfig(),
      key: sessionTarget.sessionKey,
      agentId: sessionTarget.agentId,
    });
    const execute = vi.spyOn(f.tunnel, "runWorkspaceCommand");
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      using access = await resolveRepositoryWorkspaceAccess(loaded, context, () => {});
      if (access?.kind !== "active") {
        throw new Error("Expected live repository editor access");
      }
      await access.inspect("get", { path: "missing.txt", files: [] });
      expect(execute).toHaveBeenCalledTimes(1);
      sql.expectIdle();
      await expect(
        f.mutate(async (assertCurrent) => {
          assertCurrent();
          sql.expectIdle();
          // Repository binding is write-once; rollover changes the live session owner.
          await patchSessionEntryCore(sessionTarget, () => ({
            sessionId: `${SESSION_ID}-replacement`,
          }));
          expect(assertCurrent).toThrow("lost its exact session placement owner");
          await expect(access.inspect("get", { path: "missing.txt", files: [] })).rejects.toThrow(
            "owner changed",
          );
          expect(execute).toHaveBeenCalledTimes(1);
          sql.expectIdle();
          return { changed: false, value: undefined };
        }),
      ).rejects.toThrow("lost its exact session placement owner");
      sql.expectIdle();
    } finally {
      sql.restore();
      execute.mockRestore();
    }
  });

  it.for([
    { executionMode: "worker-turn", boundary: "ref-queue" },
    { executionMode: "remote-exec", boundary: "publication-metadata" },
  ] as const)(
    "fences $executionMode editor checkpoint writes at $boundary after draining",
    async ({ executionMode, boundary }, { signal }) => {
      const f = await fixture(executionMode);
      const before = (await f.store.get(f.repository.workspaceId))!;
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
      const unblock = () => release.resolve();
      signal.addEventListener("abort", unblock, { once: true });
      let observedBoundary = false;
      let resumes = 0;
      let assertMutationCurrent: (() => void) | undefined;
      let queueOwner: Promise<void> | undefined;
      let saving: Promise<string> | undefined;
      const imports = vi.spyOn(processExec, "runExec");
      const writes = vi.spyOn(fs, "writeFile");
      const temporary = vi.spyOn(fs, "mkdtemp");
      const fastImports = () =>
        imports.mock.calls.filter(
          ([command, args]) =>
            command === "git" && args.includes(artifactRoot) && args.includes("fast-import"),
        );
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
            if (boundary === "publication-metadata" && !observedBoundary) {
              observedBoundary = true;
              entered.resolve();
              await release.promise;
            }
            return metadata;
          },
        );
        const admittedClaims = vi.spyOn(placements, "claimWorkspaceMutationResult");
        saving = f.mutate(async (assertCurrent) => {
          assertMutationCurrent = assertCurrent;
          assertCurrent();
          await f.write("editor.txt", editorBytes);
          return { changed: true, value: "saved" };
        });
        await awaitGateBeforeSettlement(
          entered.promise,
          saving,
          "Editor save settled before its checkpoint boundary",
        );
        assert.ok(assertMutationCurrent, "Repository mutation did not admit its editor operation");
        expect(assertMutationCurrent).not.toThrow();
        expect(admittedClaims).toHaveBeenCalledTimes(1);
        const admission = admittedClaims.mock.results[0];
        assert.ok(
          admission?.type === "return",
          "Repository mutation did not return its admitted claim",
        );
        const claim = await admission.value;
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
        const pausedCandidates = await candidates();
        expect(pausedCandidates).toHaveLength(boundary === "publication-metadata" ? 1 : 0);
        if (boundary === "publication-metadata") {
          const raw = await readStagedWorkerWorkspaceResult(artifactRoot, pausedCandidates[0]!);
          expect(raw.current.baseCommit).toBe(before.baseCommit);
          expect(raw.changedEntries.map((entry) => entry.path)).toContain("editor.txt");
        }
        const importsBefore = fastImports().length;
        const writesBefore = publicationWrites();
        expect(importsBefore).toBe(boundary === "publication-metadata" ? 1 : 0);
        expect(writesBefore).toBe(0);
        expect(await f.store.get(before.workspaceId)).toEqual(before);
        const draining = await placements.startWorkspaceResultDrain(claim);
        expect(draining).toMatchObject({
          state: "draining",
          generation: claim.placementGeneration + 1,
        });
        expect(assertMutationCurrent).toThrow(
          "Repository workspace edit lost its exact session placement owner",
        );
        // Draining closes authority but leaves the worker and recovery claim alive.
        expect(f.ownerSignal.aborted).toBe(false);
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
        release.resolve();
        await expect(saving).rejects.toThrow("lost its exact session placement owner");
        await queueOwner;
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
        for (const call of fastImports()) {
          expect(call[2]).toMatchObject({ stdinFileDescriptor: expect.any(Number) });
        }
        expect(importRoots).toHaveLength(1);
        expect(await candidates()).toEqual([]);
        expect(resumes).toBe(1);
        expect(f.ownerSignal.aborted).toBe(false);
        expect(await fs.readFile(path.join(f.remote, "editor.txt"), "utf8")).toBe(editorBytes);
        expect(fastImports()).toHaveLength(importsBefore);
        expect(publicationWrites()).toBe(writesBefore);
        expect(await f.store.get(before.workspaceId)).toEqual(before);
        expect(await refs()).toBe(beforeRefs);
        await f.expectUnaccepted({ claimId: claim.claimId, stagedResultRef: null });
        expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled([saving, queueOwner]);
        signal.removeEventListener("abort", unblock);
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps editor staging SQL off the caller thread across publication blobs and unchanged saves untouched", async () => {
    const f = await fixture("worker-turn");
    const context = editorContext(f);
    context.workerRepositoryWorkspaceMutationService = f.mutations;
    const authorize = vi.fn();
    const stage = checkpoints.stageSessionRepositoryCheckpoint;
    const stageCosts: Array<{ callbacks: number; statements: number }> = [];
    for (const blobCount of [1, 8]) {
      authorize.mockClear();
      // Fixed raw inventory/byte count; only publication deduplication varies.
      const content = (index: number) => `sample-${blobCount}-blob-${index % blobCount}\n`;
      for (let index = 0; index < 8; index++) {
        await f.write(`edit-${index}.txt`, content(index));
      }
      await f.write("edit-0.txt", "before\n");
      using access = await resolveRepositoryWorkspaceAccess(
        await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: context.getRuntimeConfig(),
          key: sessionTarget.sessionKey,
          agentId: sessionTarget.agentId,
        }),
        context,
        authorize,
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
        await expect(
          access.inspect(
            "set",
            {
              path: "edit-0.txt",
              content: content(0),
              expectedHash: createHash("sha256").update("before\n").digest("hex"),
            },
            authorize,
          ),
        ).resolves.toMatchObject({ status: "updated" });
      } finally {
        observer.mockRestore();
        sql.restore();
      }
      await withSessionRepositoryCheckpoint(
        { workspaceId: f.repository.workspaceId, includePublication: true },
        async (snapshot) => {
          expect(snapshot.changedEntries).toHaveLength(8);
          await expect(
            fs.readdir(path.join(snapshot.publicationStagingRoot!, "blobs")),
          ).resolves.toHaveLength(blobCount);
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
    expect(stageCosts[0]!.statements).toBe(0);
    expect(stageCosts[1]).toEqual(stageCosts[0]);
    const accepted = await f.store.get(f.repository.workspaceId);
    await expect(f.mutate(async () => ({ changed: false, value: "unchanged" }))).resolves.toBe(
      "unchanged",
    );
    expect(await f.store.get(f.repository.workspaceId)).toEqual(accepted);
    await f.expectSettled();
  });

  it("recovers unknown editor writes through pending result custody", async () => {
    const f = await fixture("worker-turn");
    const content = "write completed before transport loss\n";
    await expect(
      f.mutate(async () => {
        await f.write("uncertain.txt", content);
        throw new Error("editor transport lost the acknowledgement");
      }),
    ).rejects.toThrow("lost the acknowledgement");
    await f.expectUnaccepted();
    await recover(f);
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    const checkpoint = await readArtifact(f.repository.workspaceId, "uncertain.txt");
    expect(checkpoint.preview).toEqual(new Uint8Array(Buffer.from(content)));
    assert.ok(checkpoint.preview);
    expect(checkpoint.preview.byteOffset).toBe(0);
    expect(checkpoint.preview.buffer.byteLength).toBe(checkpoint.preview.byteLength);
  });

  it("preserves editor result custody when capture returns without durable acceptance", async () => {
    const f = await fixture("worker-turn");
    vi.spyOn(f.tunnel, "reconcileWorkspace").mockResolvedValue({
      manifestRef: placements.get(SESSION_ID)!.workspaceBaseManifestRef!,
      changed: true,
      verifyStable: async () => {},
      verifyLocalStable: async () => {},
      publishStagedResult: async () => {},
      discardPreparedStagedResult: async () => {},
    });
    await expect(f.save("unaccepted.txt", "save requires a checkpoint\n")).rejects.toThrow(
      "not durably accepted",
    );
    expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBe(
      f.initialCheckpointRef,
    );
    await f.expectUnaccepted();
  });

  it.each(["publisher", "editor"] as const)(
    "excludes competing publication and editor writes when the %s acquires first",
    async (firstOwner) => {
      const f = await fixture("worker-turn");
      const competing = vi.fn(async () => ({ changed: false, value: "unexpected" }));
      if (firstOwner === "publisher") {
        await placements.withRepositoryWorkspaceReservation(sessionTarget, async (assertOwned) => {
          await expect(f.mutate(competing)).rejects.toThrow("being published");
          assertOwned();
        });
      } else {
        await f.mutate(async (assertCurrent) => {
          await expect(
            placements.withRepositoryWorkspaceReservation(sessionTarget, competing),
          ).rejects.toBeInstanceOf(SessionWorkspaceReservationBusyError);
          assertCurrent();
          return { changed: false, value: "unchanged" };
        });
      }
      expect(competing).not.toHaveBeenCalled();
      await f.expectSettled();
    },
  );

  it("rejects editor writes during an admitted turn and fences writes if their placement starts draining", async () => {
    const f = await fixture("worker-turn");
    const activeTurn = await f.beginTurn("running-turn");
    const mutate = vi.fn(async () => ({ changed: true, value: "unexpected" }));
    await expect(f.mutate(mutate)).rejects.toThrow("active turn claim");
    expect(mutate).not.toHaveBeenCalled();
    await placements.acceptWorkspaceResult(activeTurn.turnClaim);
    await placements.completeWorkspaceResultAndReleaseTurn(activeTurn.turnClaim);

    await expect(
      f.mutate(async () => {
        await f.write("interrupted.txt", "must remain recoverable\n");
        await expect(
          placements.startDrain({
            sessionId: SESSION_ID,
            environmentId: activeTurn.placement.environmentId,
            ownerEpoch: activeTurn.placement.activeOwnerEpoch,
            expectedGeneration: activeTurn.placement.generation,
          }),
        ).rejects.toThrow("pending cloud workspace result");
        const claim = projectWorkerSessionTurnClaim(placements.get(SESSION_ID)!);
        expect(claim).toBeDefined();
        await placements.startWorkspaceResultDrain(claim!);
        return { changed: true, value: "unaccepted" };
      }),
    ).rejects.toThrow("lost its exact session placement owner");
    expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBe(
      f.initialCheckpointRef,
    );
    await f.expectUnaccepted();
  });

  it("retains setup and cumulative changes through turns, editor saves, and Stop", async () => {
    const f = await fixture("worker-turn", true);
    const pinned = (await f.store.get(f.repository.workspaceId))!;
    expect(pinned.manifestHash).not.toBe(pinned.baseManifestHash);
    await f.write("first.txt", "first turn\n");
    const first = await f.beginTurn("first");
    await f.finishTurn(first);
    await f.write("second.txt", "second turn\n");
    await f.finishTurn(await f.beginTurn("second"));
    await f.finishTurn(await f.beginTurn("read-only"));
    await f.save("editor.txt", "editor save\n");
    await f.stop(sessionTarget);
    expect(placements.get(SESSION_ID)?.state).toBe("reclaimed");
    const expected = {
      "editor.txt": "editor save\n",
      "first.txt": "first turn\n",
      "second.txt": "second turn\n",
      "setup.txt": "prepared\n",
    };
    await withSessionRepositoryCheckpoint(
      { workspaceId: f.repository.workspaceId },
      async (snapshot) => {
        expect(snapshot.changedEntries.map((entry) => entry.path)).toEqual(Object.keys(expected));
        await expectWorkspaceFiles(snapshot.stagingRoot, expected);
        expect(snapshot.baseManifestRef).toBe(pinned.baseManifestHash);
      },
    );
    expect((await f.store.get(f.repository.workspaceId))?.baseManifestHash).toBe(
      pinned.baseManifestHash,
    );
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
    await f.expectSettled();
  });

  it("binds a staged repository result to its exact immutable session owner", async () => {
    const f = await fixture("worker-turn");
    const { workspaceId } = f.repository;
    const { turnClaim } = await f.beginTurn("source-binding");
    const foreign = await f.store.create({
      agentId: sessionTarget.agentId,
      sessionKey: "agent:main:other-repository",
      url: f.repository.url,
      assertCurrent: () => {},
    });
    const ref = workerWorkspaceResultRef(turnClaim.claimId);
    await expect(
      placements.recordStagedWorkspaceResult(turnClaim, ref, foreign.workspaceId),
    ).rejects.toThrow("repository owner changed");
    expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
      { stagedResultRef: null },
    ]);
    const hostSql = observeMainThreadSql();
    hostSql.calibrate();
    try {
      const submitted = { ...turnClaim, owner: { ...turnClaim.owner } };
      const recording = placements.recordStagedWorkspaceResult(submitted, ref, workspaceId);
      submitted.claimId = "changed-after-submission";
      submitted.placementGeneration += 1;
      await recording;
      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }
    await expect(placements.recordStagedWorkspaceResult(turnClaim, ref)).rejects.toThrow(
      "result ref changed",
    );
    expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
      {
        stagedResultRef: ref,
        repositoryWorkspaceId: workspaceId,
      },
    ]);
  });

  it.each([false, true])(
    "recovers an accepted checkpoint after restart (materialized=%s)",
    async (materialized) => {
      const f = await fixture("worker-turn");
      await f.write("survives.txt", "durable before restart\n");
      const owned = await f.beginTurn("interrupted", !materialized);
      const destination = path.join(root, "materialized-worktree");
      if (materialized) {
        await placements.beginPlacementMove({
          sessionId: SESSION_ID,
          source: {
            generation: owned.placement.generation,
            environmentId: owned.placement.environmentId,
            ownerEpoch: owned.placement.activeOwnerEpoch,
          },
          target: { kind: "gateway" },
        });
        await placements.markWorkspaceResultPending(owned.turnClaim);
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
          .mockRejectedValueOnce(new Error("process exited before pending pointer"));
        await expect(f.finishTurn(owned)).rejects.toThrow("process exited before pending pointer");
        record.mockRestore();
      }
      const checkpointRef = workerWorkspaceResultRef(owned.turnClaim.claimId);
      expect((await f.store.get(f.repository.workspaceId))?.checkpointRef).toBe(checkpointRef);
      expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
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
      const reportFailure = vi.fn(async () => {});
      await recover(
        f,
        restarted,
        environments,
        createWorkerWorkspaceRecoveryFixture({
          resolveWorkspace: materialized
            ? async () => ({ kind: "local", path: destination })
            : f.resolveWorkspace,
          reportFailure,
        }),
      );
      expect(reportFailure).not.toHaveBeenCalled();
      expect(await restarted.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(restarted.get(SESSION_ID)).toMatchObject({
        state: materialized ? "local" : "reclaimed",
        turnClaim: null,
      });
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect((await readArtifact(f.repository.workspaceId, "survives.txt")).preview).toEqual(
        new Uint8Array(Buffer.from("durable before restart\n")),
      );
    },
  );
});
