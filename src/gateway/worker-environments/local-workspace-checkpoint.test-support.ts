import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  nextEventLoopTurn,
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
  deferCleanup = false,
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
      await fs.cp(source, destination, { recursive: true });
    });
    vi.spyOn(nativeWorktreeFilesystem, "remove").mockImplementation(
      async (destination, options) => {
        expect(paused).toBe(false);
        if (deferCleanup) {
          removing.resolve();
          await releaseRemoval.promise;
          // Cleanup retains its lease after the accepted command releases its caller.
          options.commitGuard();
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
      let finalizedAccepted = false;
      void finalized.then(
        () => {
          finalizedAccepted = true;
        },
        () => {},
      );
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
      if (deferCleanup && command === 3) {
        await removing.promise;
        await nextEventLoopTurn();
        expect(finalizedAccepted, "Saved command still waits for capture cleanup").toBe(true);
        await finalized;
        await expectText(owner.worktree.path, "source.txt", "modified\n");
        projection[Symbol.dispose]();
        expect(disposed).toBe(true);
        await expect(
          withOpenClawStateLeaseAsync(
            {
              scope: "workspace.local-reconciliation",
              key: owner.worktree.id,
              leaseMs: 60_000,
              waitMs: 0,
            },
            captureWorktreeRunEndContext(owner.env ?? process.env),
            async () => {},
          ),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_HELD" });
        releaseRemoval.resolve();
        await withStore({ ...owner, worktreeId: owner.worktree.id }, async () => {});
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

  it("acknowledges saved commands before capture cleanup while retaining its lease after caller disposal", () =>
    proveUnchangedSandboxCommandCheckpoints(owner(), true, false, true, true));

  it("keeps fast small workspaces on paused capture even when btrfs snapshots are available", () =>
    proveUnchangedSandboxCommandCheckpoints(owner(), false, false, "small"));
}
