import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-error.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease-error.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import { prepareSandboxCheckpointFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { provePublicationPauseAttribution } from "./local-workspace-publication.test-support.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";

let checkpointLog: Mock<(message: string) => void>;

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

async function proveCheckpointProjectionCallerStop(owner: LocalWorkspaceOwner) {
  const caller = new AbortController();
  using projection = await prepareSandboxCheckpointFixture(
    owner,
    () => caller.signal.throwIfAborted(),
    caller.signal,
  );
  const worker = await import("./workspace-manifest-worker.js");
  const stores = await import("./local-workspace-store.js");
  const preparePatch = worker.prepareWorkspacePatch;
  const patch = vi.spyOn(worker, "prepareWorkspacePatch");
  // Leave a real staged host receipt for checkpoint's settle path to import.
  patch.mockRejectedValueOnce(new Error("private fixture path must not enter diagnostics"));
  await writeText(owner.worktree.path, "source.txt", "host update\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("projection")),
  ).rejects.toThrow("private fixture path");
  const withStore = stores.withLocalWorkspaceStore;
  let journals = 0;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        update: (row, update, authority, manifest, pack) => {
          if (update.journal_json) {
            journals++;
          }
          return store.update(row, update, authority, manifest, pack);
        },
      }),
    ),
  );
  patch.mockImplementationOnce(async (params) => {
    const prepared = await preparePatch(params);
    caller.abort(createAgentRunDirectAbortError(true));
    return prepared;
  });
  await projection.checkpoint();
  expect(caller.signal.aborted).toBe(true);
  await expectText(projection.workspaceDir, "source.txt", "host update\n");
  using next = await prepareSandboxCheckpointFixture(owner);
  expect(next.workspaceDir).toBe(projection.workspaceDir);
  expect(journals, "Caller stop must not make preparation write another journal").toBe(1);
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    journal_json: null,
    pending_ref: null,
  });
  const finishes = checkpointLog.mock.calls
    .map(([message]) => message)
    .filter((message) => message.startsWith("Local workspace reconcile finish:"));
  expect(finishes.some((message) => message.includes("outcome=applied"))).toBe(true);
  expect(
    finishes.some((message) => message.includes("abortReason=operation-failed phase=patch")),
  ).toBe(true);
  expect(finishes.join("\n")).not.toContain("private fixture path");
}

async function proveReconcilePauseWindow(owner: LocalWorkspaceOwner) {
  const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  const registry = await import("../../agents/sandbox/registry.js");
  const engine = await import("../../agents/sandbox/container-engine.js");
  const worker = await import("./workspace-manifest-worker.js");
  const recovery = await import("./workspace-reconcile-recovery.js");
  const reconciliation = await import("./workspace-reconcile.js");
  const core = await import("./workspace-reconcile-core.js");
  let measuredPhase: string | undefined;
  const reconcile = reconciliation.applyStagedWorkerWorkspace;
  vi.spyOn(reconciliation, "applyStagedWorkerWorkspace").mockImplementation((params) =>
    reconcile({
      ...params,
      onPhase: (phase) => {
        measuredPhase = phase;
        params.onPhase?.(phase);
      },
    }),
  );
  const preflight = core.preflightWorkspaceApply;
  vi.spyOn(core, "preflightWorkspaceApply").mockImplementation((params) => {
    expect(measuredPhase, "Every preflight must have truthful pause attribution").toBe("preflight");
    return preflight(params);
  });
  vi.stubEnv("DOCKER_HOST", "unix:///synthetic/reconcile-docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  let paused = false;
  vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    if (args[0] === "pause") {
      paused = true;
    }
    if (args[0] === "unpause") {
      paused = false;
    }
    return {
      code: 0,
      stderr: "",
      stdout:
        args[0] === "inspect"
          ? args.includes("{{.State.Paused}}")
            ? String(paused)
            : `${"a".repeat(64)} true ${paused}`
          : "",
    };
  });
  await registry.updateRegistry({
    containerName: "reconcile-fixture",
    backendId: "docker",
    sessionKey: owner.sessionKey,
    workspaceDir: projection,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "fixture",
  });
  const patch = worker.prepareWorkspacePatch;
  const capture = worker.captureWorkspaceManifest;
  let targetCaptures = 0;
  vi.spyOn(worker, "captureWorkspaceManifest").mockImplementation(async (params) => {
    if (params.root === projection) {
      targetCaptures++;
    }
    return capture(params);
  });
  let concurrentEdit = false;
  vi.spyOn(worker, "prepareWorkspacePatch").mockImplementation(async (params) => {
    expect(paused, "Git patch preparation must not freeze the guest").toBe(false);
    const result = await patch(params);
    if (concurrentEdit) {
      await writeText(projection, "source.txt", "guest edit\n");
    }
    return result;
  });
  const apply = recovery.applyWorkspacePatch;
  vi.spyOn(recovery, "applyWorkspacePatch").mockImplementation(async (params) => {
    expect(paused, "Guest filesystem mutation needs the pause").toBe(true);
    return apply(params);
  });
  await writeText(owner.worktree.path, "source.txt", "host edit\n");
  await withLocalWorkspaceProjection(owner, (state) => state.synchronize("projection"));
  await expectText(projection, "source.txt", "host edit\n");
  expect(targetCaptures, "Checkpoint acceptance must reuse its already prepared tree").toBe(0);
  expect(paused).toBe(false);
  concurrentEdit = true;
  await writeText(owner.worktree.path, "source.txt", "next host edit\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("projection")),
  ).rejects.toThrow("changed while cloud reconciliation was being prepared");
  await expectText(projection, "source.txt", "guest edit\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.journal_json).toBeNull();
  expect(paused).toBe(false);
  concurrentEdit = false;
  await writeText(projection, "source.txt", "host edit\n");
  await withLocalWorkspaceProjection(owner, (state) => state.settle());
}

async function proveLocalWorkspaceCaptures(
  owner: LocalWorkspaceOwner,
  resumeAfterCapture = false,
  failAcceptance = false,
  atomicCapture:
    | boolean
    | "nested"
    | "direct"
    | "non-subvolume"
    | "btrfs-unavailable"
    | "clone-unavailable" = false,
  deferredCleanup?: { signal: AbortSignal; failRemoval?: boolean },
) {
  const { bindLocalSandboxWorkspace } = await import("../../agents/sandbox/local-workspace.js");
  const { createSandboxTestContext } = await import("../../agents/sandbox/test-fixtures.js");
  const { createHostSandboxFsBridge } =
    await import("../../agents/test-helpers/host-sandbox-fs-bridge.js");
  const stores = await import("./local-workspace-store.js");
  const registry = await import("../../agents/sandbox/registry.js");
  const engine = await import("../../agents/sandbox/container-engine.js");
  let disposed = false;
  using projection = await prepareSandboxCheckpointFixture({
    ...owner,
    assertCurrent: () => {
      owner.assertCurrent();
      if (disposed) {
        throw new Error("Checkpoint caller disposed");
      }
    },
    [Symbol.dispose]: () => {
      disposed = true;
    },
  });
  const removing = createDeferred();
  const releaseRemoval = createDeferred();
  const nextProbe = createDeferred();
  let removalStarted = false;
  let refuseRemoval = deferredCleanup?.failRemoval ?? false;
  let captures = 0;
  const retiredCaptures = async () =>
    (await fs.readdir(path.dirname(projection.workspaceDir))).filter((name) =>
      /^checkpoint-retired-[a-f0-9-]{36}$/u.test(name),
    );
  const containerName = "unchanged-command-fixture";
  const backend: SandboxBackendHandle = {
    id: "docker",
    runtimeId: containerName,
    runtimeLabel: containerName,
    workdir: "/workspace",
    buildExecSpec: async () => ({ argv: ["true"], env: {}, stdinMode: "pipe-closed" }),
    runShellCommand: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
  };
  bindLocalSandboxWorkspace(
    createSandboxTestContext({
      overrides: {
        workspaceDir: projection.workspaceDir,
        backend,
        fsBridge: createHostSandboxFsBridge(projection.workspaceDir),
      },
    }),
    projection,
  );
  vi.stubEnv("DOCKER_HOST", "unix:///synthetic/checkpoint-docker.sock");
  vi.stubEnv("DOCKER_CONTEXT", undefined);
  let paused = false;
  let pauses = 0;
  const messages: string[] = [];
  checkpointLog.mockImplementation((message) => {
    if (!message.startsWith("Local workspace checkpoint capture:")) {
      return;
    }
    expect(paused, "Successful and interrupted-acceptance diagnostics follow resume").toBe(false);
    messages.push(message);
  });
  const takesSnapshot = atomicCapture === true || atomicCapture === "nested";
  const reconcile = atomicCapture && atomicCapture !== "direct";
  let beforePauseEdit: (() => Promise<void>) | undefined;
  if (atomicCapture === "direct") {
    const worker = await import("./workspace-manifest-worker.js");
    const prepare = worker.prepareWorkspaceStageInput;
    const { parseWorkerWorkspaceManifest } = await import("./workspace-manifest.js");
    const { parseChangedWorkspaceResult } = await import("./workspace-manifest-comparison.js");
    vi.spyOn(worker, "prepareWorkspaceStageInput").mockImplementation(async (input, authority) => {
      if (
        !("publication" in input) &&
        !input.existingObjects?.length &&
        parseChangedWorkspaceResult(
          parseWorkerWorkspaceManifest(
            input.baseManifestRaw,
            input.baseManifestRef,
            input.buildCacheInputs,
          ),
          parseWorkerWorkspaceManifest(
            input.currentManifestRaw,
            input.currentManifestRef,
            input.buildCacheInputs,
          ),
        ).entries.length
      ) {
        expect(paused, "Changed payload preparation must run before the guest pause").toBe(false);
      }
      const result = await prepare(input, authority);
      if (input.blobsOnly && beforePauseEdit) {
        await beforePauseEdit();
        beforePauseEdit = undefined;
      }
      return result;
    });
  }
  if (atomicCapture) {
    const { nativeWorktreeFilesystem } =
      await import("../../agents/worktrees/filesystem-native.js");
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stats = await lstat(...args);
      if (args[0] === projection.workspaceDir) {
        Reflect.set(stats, "ino", atomicCapture === "non-subvolume" ? 257n : 256n);
      }
      return stats;
    });
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue(
      atomicCapture === "btrfs-unavailable" ? undefined : "btrfs",
    );
    vi.spyOn(nativeWorktreeFilesystem, "copy").mockImplementation(async (source, destination) => {
      expect(atomicCapture, "Command checkpoints must avoid snapshot creation").not.toBe("direct");
      expect(paused, "Reconcile captures retain frozen guest custody").toBe(true);
      if (deferredCleanup) {
        expect(await retiredCaptures(), "A previous retired capture still owns disk space").toEqual(
          [],
        );
      }
      if (atomicCapture === "clone-unavailable") {
        throw Object.assign(new Error("Clone unavailable"), { code: "CLONE_UNAVAILABLE" });
      }
      captures++;
      await fs.cp(source, destination, { recursive: true });
      if (takesSnapshot && captures === 1) {
        await writeText(projection.workspaceDir, "source.txt", "later background edit\n");
      }
    });
    vi.spyOn(nativeWorktreeFilesystem, "remove").mockImplementation(
      async (destination, options) => {
        expect(paused).toBe(false);
        if (deferredCleanup && path.basename(destination).startsWith("checkpoint-retired-")) {
          removalStarted = true;
          removing.resolve();
          await releaseRemoval.promise;
          // Artifact custody survives release of the command's session owner.
          options.commitGuard();
          if (refuseRemoval) {
            throw Object.assign(new Error("Retired capture removal refused"), { code: "EACCES" });
          }
        }
        await fs.rm(destination, { recursive: true, force: true });
      },
    );
  }
  const reconciler = await import("./workspace-reconcile.js");
  const apply = reconciler.applyStagedWorkerWorkspace;
  const accepting = createDeferred();
  const accept = createDeferred();
  let recovering = false;
  let firstAcceptance = true;
  if (resumeAfterCapture) {
    vi.spyOn(reconciler, "applyStagedWorkerWorkspace").mockImplementation(async (params) => {
      // Canonical publication consumes captured bytes while the guest keeps running.
      expect(paused).toBe(recovering && !reconcile);
      recovering = false;
      if (firstAcceptance) {
        firstAcceptance = false;
        if (!atomicCapture) {
          await writeText(projection.workspaceDir, "source.txt", "later background edit\n");
        }
        accepting.resolve();
        await accept.promise;
        if (failAcceptance) {
          return apply({
            ...params,
            journal: {
              ...params.journal,
              commit: async () => {
                recovering = true;
                throw new AcceptedWorkspacePublicationIndeterminateError(
                  "commit",
                  new Error("interrupted acceptance"),
                );
              },
            },
          });
        }
      }
      return apply(params);
    });
  }
  vi.spyOn(engine, "execContainer").mockImplementation(async (_engine, args) => {
    let stdout = "";
    if (args[0] === "info") {
      stdout = "checkpoint-daemon";
    } else if (args[0] === "inspect") {
      stdout = args.includes("{{.State.Paused}}")
        ? String(paused)
        : `${"a".repeat(64)} true ${paused}`;
    } else if (args[0] === "pause") {
      paused = true;
      pauses++;
    } else if (args[0] === "unpause") {
      paused = false;
    }
    return { code: 0, stdout, stderr: "" };
  });
  const withStore = stores.withLocalWorkspaceStore;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) => {
      if (deferredCleanup && removalStarted) {
        nextProbe.resolve();
      }
      return run({
        ...store,
        manifest: async (row, action) => {
          if (action.kind === "scan") {
            expect(paused).toBe(!action.capture && !action.prehash);
            if (atomicCapture === "nested" && action.capture) {
              // The manifest worker reports omitted nested subvolumes before preparing CAS writes.
              throw Object.assign(new Error("Btrfs snapshot omitted a nested subvolume"), {
                code: "WORKSPACE_SNAPSHOT_INCOMPLETE",
              });
            }
          }
          const result = await store.manifest(row, action);
          // Exercise a large inventory without making the regression fixture expensive.
          return atomicCapture === "direct" && action.kind === "probe" && result.kind === "rescan"
            ? { ...result, entryCount: 20_000 }
            : result;
        },
      });
    }),
  );
  await registry.updateRegistry({
    containerName,
    backendId: "docker",
    sessionKey: owner.sessionKey,
    workspaceDir: projection.workspaceDir,
    createdAtMs: 1,
    lastUsedAtMs: 1,
    image: "fixture",
  });
  try {
    await writeText(owner.worktree.path, "host.txt", "independent host edit\n");
    for (let command = 0; command < 10; command++) {
      if (reconcile && command !== 3 && command !== 4 && command !== 7) {
        continue;
      }
      const spec = reconcile
        ? undefined
        : await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      if (command === 3) {
        const source = path.join(projection.workspaceDir, "source.txt");
        const before = await fs.stat(source);
        await fs.writeFile(source, "modified\n");
        await fs.utimes(source, before.atime, before.mtime);
      } else if (command === 7) {
        await fs.unlink(path.join(projection.workspaceDir, "source.txt"));
      }
      const finalized = reconcile
        ? withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"))
        : backend.finalizeExec!({
            status: "completed",
            exitCode: 0,
            timedOut: false,
            token: spec!.finalizeToken,
          });
      if (resumeAfterCapture && command === 3) {
        try {
          await awaitGateBeforeSettlement(
            accepting.promise,
            finalized,
            "Command finished before canonical acceptance",
          );
          await expectText(owner.worktree.path, "source.txt", "original\n");
        } finally {
          accept.resolve();
        }
        if (failAcceptance) {
          await expect(finalized).rejects.toThrow("indeterminate");
          expect(paused).toBe(false);
          if (!reconcile) {
            expect(messages.at(-1)).toContain("accepted=false");
          }
          expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
            pending_target: "canonical",
            journal_json: expect.any(String),
          });
          await expectText(projection.workspaceDir, "source.txt", "later background edit\n");
          continue;
        }
      }
      if (deferredCleanup && command === 3) {
        await removing.promise;
        await withinTest(finalized, deferredCleanup.signal);
        await expectText(owner.worktree.path, "source.txt", "modified\n");
        await withOpenClawStateLeaseAsync(
          {
            scope: "workspace.local-reconciliation",
            key: owner.worktree.id,
            leaseMs: 60_000,
            waitMs: 0,
          },
          captureWorktreeRunEndContext(owner.env ?? process.env),
          async () => {},
        );
        // The next command's preparation and execution can overlap artifact cleanup.
        await projection.provision(() =>
          writeText(projection.workspaceDir, "source.txt", "next command edit\n"),
        );
        projection[Symbol.dispose]();
        expect(disposed).toBe(true);
        const next = withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
        let nextSettled = false;
        void next.then(
          () => {
            nextSettled = true;
          },
          () => {
            nextSettled = true;
          },
        );
        await withinTest(nextProbe.promise, deferredCleanup.signal);
        await nextEventLoopTurn();
        expect(nextSettled).toBe(false);
        expect(captures).toBe(1);
        expect(paused).toBe(false);
        expect(await retiredCaptures()).toHaveLength(1);
        releaseRemoval.resolve();
        if (deferredCleanup.failRemoval) {
          await expect(next).rejects.toMatchObject({ code: "EACCES" });
          expect(captures).toBe(1);
          expect(await retiredCaptures()).toHaveLength(1);
          await expectText(owner.worktree.path, "source.txt", "modified\n");
          // A failed job has left the in-flight registry: the next admission must
          // discover its artifact just as it does after process restart.
          refuseRemoval = false;
          const unrelated = path.join(
            path.dirname(projection.workspaceDir),
            "checkpoint-retired-not-a-uuid",
          );
          await fs.mkdir(unrelated);
          await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
          expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
        } else {
          await withinTest(next, deferredCleanup.signal);
        }
        await expectText(owner.worktree.path, "source.txt", "next command edit\n");
        await expectMissing(path.dirname(projection.workspaceDir), "checkpoint-capture");
        return;
      }
      await finalized;
      if (command === 3 && !reconcile) {
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(`worktree=${owner.worktree.id}`);
        expect(messages[0]).toContain("path=paused reason=adaptive-direct attemptedSnapshot=false");
        expect(messages[0]).toMatch(
          /preCopyMs=- copyMs=- postCopyBeforeResumeMs=- resumeMs=[0-9]+\.[0-9] accepted=true$/u,
        );
      }
      expect(paused).toBe(false);
      await expectText(owner.worktree.path, "host.txt", "independent host edit\n");
      await expectMissing(projection.workspaceDir, "host.txt");
      if (command < 7) {
        await expectText(
          owner.worktree.path,
          "source.txt",
          command < 3
            ? "original\n"
            : resumeAfterCapture && (command > 3 || atomicCapture === "nested")
              ? "later background edit\n"
              : "modified\n",
        );
      } else {
        await expectMissing(owner.worktree.path, "source.txt");
      }
    }
    if (!reconcile) {
      expect(pauses).toBe(resumeAfterCapture ? 3 : 2);
    }
    if (atomicCapture) {
      await expectMissing(path.dirname(projection.workspaceDir), "checkpoint-capture");
    }
    if (atomicCapture === "direct") {
      for (const name of ["keep.txt", "rewrite.txt", "remove.txt"]) {
        await writeText(projection.workspaceDir, name, "before\n");
      }
      beforePauseEdit = async () => {
        const source = path.join(projection.workspaceDir, "rewrite.txt");
        const before = await fs.stat(source);
        await fs.writeFile(source, "after!\n");
        await fs.utimes(source, before.atime, before.mtime);
        await fs.unlink(path.join(projection.workspaceDir, "remove.txt"));
        await writeText(projection.workspaceDir, "added.txt", "during prehash\n");
      };
      await projection.checkpoint();
      expect(beforePauseEdit).toBeUndefined();
      await expectText(owner.worktree.path, "keep.txt", "before\n");
      await expectText(owner.worktree.path, "rewrite.txt", "after!\n");
      await expectText(owner.worktree.path, "added.txt", "during prehash\n");
      await expectMissing(owner.worktree.path, "remove.txt");
      const before = pauses;
      await projection.checkpoint();
      expect(pauses).toBe(before);
    }
  } finally {
    accept.resolve();
    releaseRemoval.resolve();
    checkpointLog.mockImplementation(() => {});
    await registry.removeRegistryEntry(containerName);
  }
}

export function registerSandboxCheckpointTests(
  owner: () => LocalWorkspaceOwner,
  logObserver: typeof checkpointLog,
) {
  checkpointLog = logObserver;
  it("resumes after publication capture and preserves guest writes during canonical Git staging", () =>
    provePublicationPauseAttribution(owner(), checkpointLog));
  it("finishes checkpoint-owned projection work after caller stop without replaying its journal", () =>
    proveCheckpointProjectionCallerStop(owner()));
  it("records closed reconcile abort reasons without replacing the original failure", async () => {
    const { withLocalWorkspaceReconciliation } = await import("./local-workspace-store.js");
    for (const [failure, reason] of [
      [createAgentRunDirectAbortError(true), "stop"],
      [
        new OpenClawStateLeaseError("private", { code: "OPENCLAW_STATE_LEASE_ABORTED" }),
        "OPENCLAW_STATE_LEASE_ABORTED",
      ],
      [
        new OpenClawStateLeaseError("private", {
          code: "OPENCLAW_STATE_LEASE_LOST",
          loss: { reason: "missing" },
        }),
        "lease-missing",
      ],
      [new SqliteWorkerError("private", "outcome-unknown"), "sqlite-outcome-unknown"],
      [
        new AcceptedWorkspacePublicationIndeterminateError("commit", new Error("private")),
        "publication-indeterminate",
      ],
      [
        Object.assign(new Error("private"), { code: "private", name: "private" }),
        "operation-failed",
      ],
    ] as const) {
      await expect(
        withLocalWorkspaceReconciliation(
          {
            worktreeId: owner().worktree.id,
            pendingRef: "synthetic",
            baseCommit: null,
            targetCommit: null,
            target: "projection",
            reason: "checkpoint",
          },
          async (markPhase) => {
            markPhase("patch");
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      expect(checkpointLog.mock.lastCall?.[0]).toContain(`abortReason=${reason} phase=patch`);
      expect(checkpointLog.mock.lastCall?.[0]).not.toContain("private");
    }
  });
  it("keeps the guest running during reconcile patch preparation and fences concurrent edits", () =>
    proveReconcilePauseWindow(owner()));
  it("keeps unchanged commands running while checkpointing edits and deletions", () =>
    proveLocalWorkspaceCaptures(owner()));

  it.each([false, true])(
    "resumes captured commands without losing later guest writes (interrupted acceptance: %s)",
    (interrupted) => proveLocalWorkspaceCaptures(owner(), true, interrupted),
  );

  it.each([false, true])(
    "captures reconciliation snapshots while preserving later writes (interrupted acceptance: %s)",
    (interrupted) => proveLocalWorkspaceCaptures(owner(), true, interrupted, true),
  );

  it("re-pauses omitted nested subvolumes under the checkpoint lease before saving their live bytes", () =>
    proveLocalWorkspaceCaptures(owner(), true, false, "nested"));

  it.for([false, true])(
    "overlaps retired capture cleanup with the next command while bounding capture admission (cleanup failure: %s)",
    (failRemoval, { signal }) =>
      proveLocalWorkspaceCaptures(owner(), true, false, true, {
        signal,
        failRemoval,
      }),
  );

  it.each(["non-subvolume", "btrfs-unavailable", "clone-unavailable"] as const)(
    "reconciles with paused capture when snapshot creation is unavailable: %s",
    (reason) => proveLocalWorkspaceCaptures(owner(), false, false, reason),
  );

  it("checkpoints large workspaces without creating disposable snapshots", () =>
    proveLocalWorkspaceCaptures(owner(), false, false, "direct"));
}
