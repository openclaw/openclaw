import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

async function proveUnchangedSandboxCommandCheckpoints(
  owner: LocalWorkspaceOwner,
  resumeAfterCapture = false,
  failAcceptance = false,
  atomicCapture: boolean | "nested" | "small" = false,
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
  if (atomicCapture) {
    const { nativeWorktreeFilesystem } =
      await import("../../agents/worktrees/filesystem-native.js");
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stats = await lstat(...args);
      if (args[0] === projection.workspaceDir) {
        Reflect.set(stats, "ino", 256n);
      }
      return stats;
    });
    vi.spyOn(nativeWorktreeFilesystem, "probe").mockResolvedValue("btrfs");
    vi.spyOn(nativeWorktreeFilesystem, "copy").mockImplementation(async (source, destination) => {
      expect(atomicCapture, "Fast small workspaces must avoid snapshot creation").not.toBe("small");
      expect(paused).toBe(true);
      if (deferredCleanup) {
        expect(await retiredCaptures(), "A previous retired capture still owns disk space").toEqual(
          [],
        );
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
      if (atomicCapture && atomicCapture !== "small" && pauses === 1) {
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
    await registry.removeRegistryEntry(containerName);
  }
}

export function registerSandboxCheckpointTests(owner: () => LocalWorkspaceOwner) {
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
      proveUnchangedSandboxCommandCheckpoints(owner(), true, false, true, { signal, failRemoval }),
  );

  it("keeps fast small workspaces on paused capture even when btrfs snapshots are available", () =>
    proveUnchangedSandboxCommandCheckpoints(owner(), false, false, "small"));
}
