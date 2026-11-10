import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { SandboxBackendHandle } from "../../agents/sandbox/backend-handle.types.js";
import { captureWorktreeRunEndContext } from "../../agents/worktrees/run-end-lifecycle.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import { prepareSandboxCheckpointFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

let checkpointLog: Mock<(message: string) => void>;

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

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
  expect(targetCaptures, "The frozen target needs only one complete inventory capture").toBe(1);
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

async function proveUnchangedSandboxCommandCheckpoints(
  owner: LocalWorkspaceOwner,
  resumeAfterCapture = false,
  failAcceptance = false,
  atomicCapture:
    | boolean
    | "nested"
    | "small"
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
      expect(atomicCapture, "Fast small workspaces must avoid snapshot creation").not.toBe("small");
      expect(paused).toBe(true);
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
    });
    vi.spyOn(nativeWorktreeFilesystem, "remove").mockImplementation(
      async (destination, options) => {
        expect(paused).toBe(false);
        if (deferredCleanup) {
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
  const { AcceptedWorkspacePublicationIndeterminateError } =
    await import("./workspace-accepted-publication.js");
  const apply = reconciler.applyStagedWorkerWorkspace;
  const accepting = createDeferred();
  const accept = createDeferred();
  let recovering = false;
  let firstAcceptance = true;
  if (resumeAfterCapture) {
    vi.spyOn(reconciler, "applyStagedWorkerWorkspace").mockImplementation(async (params) => {
      // Canonical publication consumes captured bytes while the guest keeps running.
      expect(paused).toBe(recovering);
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
      if (takesSnapshot && pauses === 1) {
        await writeText(projection.workspaceDir, "source.txt", "later background edit\n");
      }
    }
    return { code: 0, stdout, stderr: "" };
  });
  const withStore = stores.withLocalWorkspaceStore;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) => {
      const initial = store.get();
      const pendingRecovery = Boolean(initial?.journal_json || initial?.pending_target);
      return run({
        ...store,
        manifest: async (row, action) => {
          if (action.kind === "scan") {
            // Recovery skips the live probe, so its fresh capture remains paused.
            // An ordinary large-workspace checkpoint must scan its snapshot after resume.
            expect(paused).toBe(atomicCapture === true ? pendingRecovery : !action.capture);
            if (atomicCapture === "nested" && action.capture) {
              // The manifest worker reports omitted nested subvolumes before preparing CAS writes.
              throw Object.assign(new Error("Btrfs snapshot omitted a nested subvolume"), {
                code: "WORKSPACE_SNAPSHOT_INCOMPLETE",
              });
            }
          }
          const result = await store.manifest(row, action);
          if (deferredCleanup && removalStarted && action.kind === "probe") {
            nextProbe.resolve();
          }
          // Native-copy ordering uses a tiny fixture with a large owner inventory fact.
          return atomicCapture &&
            atomicCapture !== "small" &&
            action.kind === "probe" &&
            result.kind === "rescan"
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
      const spec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });
      if (command === 3) {
        const source = path.join(projection.workspaceDir, "source.txt");
        const before = await fs.stat(source);
        await fs.writeFile(source, "modified\n");
        await fs.utimes(source, before.atime, before.mtime);
      } else if (command === 7) {
        await fs.unlink(path.join(projection.workspaceDir, "source.txt"));
      }
      const finalized = backend.finalizeExec!({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
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
          expect(messages.at(-1)).toContain("accepted=false");
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
        const { checkpointLocalWorkspace } = await import("./local-workspace-projection.js");
        const next = checkpointLocalWorkspace(owner);
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
          await checkpointLocalWorkspace(owner);
          expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
        } else {
          await withinTest(next, deferredCleanup.signal);
        }
        await expectText(owner.worktree.path, "source.txt", "next command edit\n");
        await expectMissing(path.dirname(projection.workspaceDir), "checkpoint-capture");
        return;
      }
      await finalized;
      if (command === 3) {
        const reason =
          atomicCapture === true
            ? "btrfs"
            : atomicCapture === "nested"
              ? "nested-incomplete"
              : !atomicCapture || atomicCapture === "small"
                ? "adaptive-direct"
                : atomicCapture;
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(`worktree=${owner.worktree.id}`);
        if (atomicCapture) {
          expect(messages[0]).toContain(
            `path=${atomicCapture === true ? "snapshot" : "paused"} reason=${reason}`,
          );
        }
        expect(messages[0]).toContain(
          `attemptedSnapshot=${takesSnapshot || atomicCapture === "clone-unavailable"}`,
        );
        expect(messages[0]).toMatch(
          /preCopyMs=(?:[0-9]+\.[0-9]|-) copyMs=(?:[0-9]+\.[0-9]|-) postCopyBeforeResumeMs=(?:[0-9]+\.[0-9]|-) resumeMs=[0-9]+\.[0-9] accepted=true$/u,
        );
        if (takesSnapshot || atomicCapture === "clone-unavailable") {
          expect(messages[0]).toMatch(/preCopyMs=[0-9]+\.[0-9] copyMs=[0-9]+\.[0-9]/u);
        } else {
          expect(messages[0]).toContain("preCopyMs=- copyMs=- postCopyBeforeResumeMs=-");
        }
        if (takesSnapshot) {
          expect(messages[0]).toMatch(/postCopyBeforeResumeMs=[0-9]+\.[0-9]/u);
        }
        if (atomicCapture === "clone-unavailable") {
          expect(messages[0]).toContain("cloneError=CLONE_UNAVAILABLE");
        }
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
    expect(pauses).toBe(atomicCapture === "nested" ? 4 : resumeAfterCapture ? 3 : 2);
    if (atomicCapture) {
      await expectMissing(path.dirname(projection.workspaceDir), "checkpoint-capture");
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
  it("keeps the guest running during reconcile patch preparation and fences concurrent edits", () =>
    proveReconcilePauseWindow(owner()));
  it("keeps unchanged commands running while checkpointing edits and deletions", () =>
    proveUnchangedSandboxCommandCheckpoints(owner()));

  it.each([false, true])(
    "resumes captured commands without losing later guest writes (interrupted acceptance: %s)",
    (interrupted) => proveUnchangedSandboxCommandCheckpoints(owner(), true, interrupted),
  );

  it.each([false, true])(
    "captures before scanning while preserving post-resume writes (interrupted acceptance: %s)",
    (interrupted) => proveUnchangedSandboxCommandCheckpoints(owner(), true, interrupted, true),
  );

  it("re-pauses omitted nested subvolumes under the checkpoint lease before saving their live bytes", () =>
    proveUnchangedSandboxCommandCheckpoints(owner(), true, false, "nested"));

  it.for([false, true])(
    "overlaps retired capture cleanup with the next command while bounding capture admission (cleanup failure: %s)",
    (failRemoval, { signal }) =>
      proveUnchangedSandboxCommandCheckpoints(owner(), true, false, true, {
        signal,
        failRemoval,
      }),
  );

  it.each(["non-subvolume", "btrfs-unavailable", "clone-unavailable"] as const)(
    "reports why snapshot capture falls back to paused capture: %s",
    (reason) => proveUnchangedSandboxCommandCheckpoints(owner(), false, false, reason),
  );

  it("keeps fast small workspaces on paused capture even when btrfs snapshots are available", () =>
    proveUnchangedSandboxCommandCheckpoints(owner(), false, false, "small"));
}
