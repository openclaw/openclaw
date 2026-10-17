import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { verifyReconciledWorkspaceFinal } from "./workspace-finalize.js";
import { prepareLocalWorkspaceReconciliation } from "./workspace-local-reconciliation.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspaceResult,
  hasWorkerWorkspaceResultRef,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function prepareUnchangedWorkspace(options?: {
  localContent?: string;
  assertCurrent?: () => void;
  beforeRemoteFence?: () => Promise<void>;
  onRenew?: (root: string) => Promise<void>;
}) {
  const root = tempDirs.make("openclaw-unchanged-reconciliation-");
  const stagingRoot = tempDirs.make("openclaw-unchanged-reconciliation-staging-");
  await fs.writeFile(path.join(root, "result.txt"), "base\n");
  const base = await captureWorkspaceManifest({ root, baseCommit: null });
  if (options?.localContent) {
    await fs.writeFile(path.join(root, "result.txt"), options.localContent);
  }
  const ref = workerWorkspaceResultRef("unchanged-result");
  const journal = {
    load: async () => undefined,
    begin: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const record = vi.fn();
  const publishAcceptedManifest = vi.fn();
  const verifyStable = vi.fn(async () => {
    await options?.beforeRemoteFence?.();
  });
  const reconcile = await prepareLocalWorkspaceReconciliation({
    request: {
      localPath: root,
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: base.manifestRef,
      journal,
      stagedResult: { ref, record },
      assertCurrent: options?.assertCurrent,
    },
    hashMemo: new Map(),
  });
  const raw = serializeWorkerWorkspaceManifest(base.manifest);
  const reconciliation = await reconcile({
    stagingRoot,
    base: base.manifest,
    current: base.manifest,
    baseRaw: raw,
    currentRaw: raw,
    currentManifestRef: base.manifestRef,
    manifestRef: () => base.manifestRef,
    publishAcceptedManifest,
    verifyStable,
  });
  const quiescence = {
    assertActive: vi.fn(async () => {
      await options?.onRenew?.(root);
    }),
    resume: vi.fn(async () => {}),
  };
  return {
    root,
    base,
    ref,
    journal,
    record,
    publishAcceptedManifest,
    verifyStable,
    reconciliation,
    quiescence,
  };
}

describe("unchanged local workspace reconciliation", () => {
  it("retains published host additions across accepted replay and a later worker deletion", async () => {
    const root = tempDirs.make("openclaw-accepted-host-recovery-");
    const worker = tempDirs.make("openclaw-accepted-host-worker-");
    const manifests = tempDirs.make("openclaw-accepted-host-manifests-");
    await requireGit(root, ["init", "--quiet"]);
    await fs.writeFile(path.join(root, "base.txt"), "base\n");
    await fs.writeFile(path.join(worker, "base.txt"), "base\n");
    await requireGit(root, ["add", "."]);
    await requireGit(root, [
      "-c",
      "user.name=Workspace Fixture",
      "-c",
      "user.email=workspace@example.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "base",
    ]);
    const baseCommit = await requireGit(root, ["rev-parse", "HEAD"]);
    const base = await captureWorkspaceManifest({ root, baseCommit });
    await fs.writeFile(
      path.join(manifests, base.manifestRef.slice(7)),
      serializeWorkerWorkspaceManifest(base.manifest),
    );
    let committedRef = base.manifestRef;
    let remoteRef = base.manifestRef;
    const journal = {
      load: async () => undefined,
      begin: async () => {},
      commit: async (ref: string) => {
        committedRef = ref;
      },
      abort: async () => {},
    };
    const ref = workerWorkspaceResultRef("accepted-host-recovery");
    const reconcile = async (baseline: typeof base, current: typeof base, stagedRef: string) => {
      const prepare = await prepareLocalWorkspaceReconciliation({
        request: {
          localPath: root,
          remoteWorkspaceDir: "/worker/workspace",
          baseManifestRef: baseline.manifestRef,
          journal,
          stagedResult: { ref: stagedRef, record: () => {} },
        },
        hashMemo: new Map(),
      });
      const reconciliation = await prepare({
        stagingRoot: worker,
        base: baseline.manifest,
        current: current.manifest,
        baseRaw: serializeWorkerWorkspaceManifest(baseline.manifest),
        currentRaw: serializeWorkerWorkspaceManifest(current.manifest),
        currentManifestRef: current.manifestRef,
        manifestRef: () => remoteRef,
        publishAcceptedManifest: async (accepted) => {
          // Synthetic transport copies real accepted fixture bytes to the worker.
          for (const entry of accepted.manifest.entries) {
            if (entry.type !== "file") {
              throw new Error("Diagnostic fixture expects regular files");
            }
            await fs.copyFile(path.join(root, entry.path), path.join(worker, entry.path));
          }
          const observed = await captureWorkspaceManifest({ root: worker, baseCommit });
          expect(observed.manifestRef).toBe(accepted.manifestRef);
          await fs.writeFile(
            path.join(manifests, accepted.manifestRef.slice(7)),
            serializeWorkerWorkspaceManifest(accepted.manifest),
          );
          remoteRef = accepted.manifestRef;
        },
        verifyStable: async () => {
          const observed = await captureWorkspaceManifest({ root: worker, baseCommit });
          expect(observed.manifestRef).toBe(remoteRef);
        },
      });
      return await verifyReconciledWorkspaceFinal(reconciliation, {
        assertActive: async () => {},
        resume: async () => {},
      });
    };
    await fs.writeFile(path.join(root, "published.txt"), "published host bytes\n");
    await requireGit(root, ["add", "--", "published.txt"]);
    const accepted = await reconcile(base, base, ref);
    expect(accepted?.manifest.entries.map((entry) => entry.path)).toEqual([
      "base.txt",
      "published.txt",
    ]);
    expect(committedRef).toBe(remoteRef);
    await expect(fs.readFile(path.join(worker, "published.txt"), "utf8")).resolves.toBe(
      "published host bytes\n",
    );
    await fs.writeFile(path.join(root, "unpublished.txt"), "later host bytes\n");
    await requireGit(root, ["add", "--", "unpublished.txt"]);
    // Match the already-accepted pending-result production call, without admitting a new index.
    const replay = await applyStagedWorkerWorkspaceResult({
      root,
      stagedResultRef: ref,
      expectedBaseManifestRef: committedRef,
      alreadyAccepted: true,
      journal,
      assertCurrent: () => {},
    });
    await replay.verifyLocalStable();
    expect(committedRef).toBe(accepted?.manifestRef);
    expect(replay.manifest.entries.some((entry) => entry.path === "unpublished.txt")).toBe(false);
    await fs.rm(path.join(worker, "published.txt"));
    const deleted = await captureWorkspaceManifest({ root: worker, baseCommit });
    remoteRef = deleted.manifestRef;
    // The next worker result resolves the placement's durable digest, not the
    // recovery helper's diagnostic snapshot, from its retained manifest registry.
    const nextBase = {
      manifestRef: committedRef,
      manifest: parseWorkerWorkspaceManifest(
        await fs.readFile(path.join(manifests, committedRef.slice(7)), "utf8"),
        committedRef,
      ),
    };
    await reconcile(nextBase, deleted, workerWorkspaceResultRef("accepted-host-delete"));
    const localPresent = await fs.access(path.join(root, "published.txt")).then(
      () => true,
      () => false,
    );
    const workerPresent = await fs.access(path.join(worker, "published.txt")).then(
      () => true,
      () => false,
    );
    expect(localPresent).toBe(false);
    expect(workerPresent).toBe(false);
  });

  it.each([false, true])(
    "publishes host-staged additions with worker changes=%s without enrolling other host files",
    async (workerChanged) => {
      const root = tempDirs.make("openclaw-staged-host-reconciliation-");
      const stagingRoot = tempDirs.make("openclaw-staged-host-reconciliation-payload-");
      await requireGit(root, ["init", "--quiet"]);
      await fs.writeFile(path.join(root, "base.txt"), "base\n");
      await fs.writeFile(path.join(root, ".gitignore"), "private.txt\n");
      await requireGit(root, ["add", "."]);
      await requireGit(root, [
        "-c",
        "user.name=Workspace Fixture",
        "-c",
        "user.email=workspace@example.invalid",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "base",
      ]);
      const baseCommit = await requireGit(root, ["rev-parse", "HEAD"]);
      const base = await captureWorkspaceManifest({ root, baseCommit });
      await fs.mkdir(path.join(root, "added"));
      await fs.writeFile(path.join(root, "added", "gateway.txt"), "gateway content\n");
      await fs.writeFile(path.join(root, "untracked.txt"), "unadmitted host bytes\n");
      await fs.writeFile(path.join(root, "private.txt"), "ignored host bytes\n");
      await requireGit(root, ["add", "--", "added/gateway.txt"]);
      let current = base;
      if (workerChanged) {
        await fs.copyFile(path.join(root, "base.txt"), path.join(stagingRoot, "base.txt"));
        await fs.copyFile(path.join(root, ".gitignore"), path.join(stagingRoot, ".gitignore"));
        await fs.writeFile(path.join(stagingRoot, "node.txt"), "node content\n");
        current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      }
      const publishAcceptedManifest = vi.fn();
      const prepare = await prepareLocalWorkspaceReconciliation({
        request: {
          localPath: root,
          remoteWorkspaceDir: "/worker/workspace",
          baseManifestRef: base.manifestRef,
          journal: {
            load: async () => undefined,
            begin: async () => {},
            commit: async () => {},
            abort: async () => {},
          },
          stagedResult: { ref: workerWorkspaceResultRef("host-staged-result"), record: () => {} },
        },
        hashMemo: new Map(),
      });
      const reconciliation = await prepare({
        stagingRoot,
        base: base.manifest,
        current: current.manifest,
        baseRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentRaw: serializeWorkerWorkspaceManifest(current.manifest),
        currentManifestRef: current.manifestRef,
        manifestRef: () => current.manifestRef,
        publishAcceptedManifest,
        verifyStable: async () => {},
      });
      const applied = await verifyReconciledWorkspaceFinal(reconciliation, {
        assertActive: async () => {},
        resume: async () => {},
      });
      expect(applied?.manifest.entries.map((entry) => entry.path)).toEqual([
        ".gitignore",
        "added/gateway.txt",
        "base.txt",
        ...(workerChanged ? ["node.txt"] : []),
      ]);
      expect(publishAcceptedManifest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ manifestRef: applied?.manifestRef, manifest: applied?.manifest }),
      );
      expect(applied?.conflictPaths).toEqual([]);
    },
  );

  it.each([undefined, "local change\n"])(
    "retains a result ref only when local content %j needs reconciliation",
    async (localContent) => {
      const f = await prepareUnchangedWorkspace({ localContent });
      const { root, base, ref, reconciliation, quiescence, journal } = f;
      const hasRef = (stagedResultRef: string) =>
        hasWorkerWorkspaceResultRef({ root, stagedResultRef });
      const prepared = preparedWorkerWorkspaceResultRef(ref);
      if (localContent) {
        expect(reconciliation.changed).toBe(false);
        expect(reconciliation.acceptUnchangedStagedResult).toBeUndefined();
      } else {
        expect(reconciliation.acceptUnchangedStagedResult).toBeTypeOf("function");
        expect(f.verifyStable).not.toHaveBeenCalled();
        expect(journal.commit).not.toHaveBeenCalled();
        await expect(hasRef(prepared)).resolves.toBe(false);
        expect(f.record).not.toHaveBeenCalled();
      }
      const applied = await verifyReconciledWorkspaceFinal(reconciliation, quiescence);
      expect(f.verifyStable).toHaveBeenCalledTimes(localContent ? 3 : 1);
      expect(quiescence.assertActive).toHaveBeenCalledTimes(localContent ? 2 : 1);
      expect(f.publishAcceptedManifest).toHaveBeenCalledTimes(localContent ? 1 : 0);
      expect(journal.commit).toHaveBeenCalledExactlyOnceWith(applied?.manifestRef);
      if (localContent) {
        expect(f.record).toHaveBeenCalledExactlyOnceWith(ref);
        await expect(hasRef(ref)).resolves.toBe(true);
        expect(applied?.manifestRef).not.toBe(base.manifestRef);
        await expect(fs.readFile(path.join(root, "result.txt"), "utf8")).resolves.toBe(
          localContent,
        );
      } else {
        expect(applied).toMatchObject({ manifestRef: base.manifestRef, conflictPaths: [] });
        expect(journal.begin).not.toHaveBeenCalled();
        expect(f.record).not.toHaveBeenCalled();
        await expect(hasRef(ref)).resolves.toBe(false);
        await expect(hasRef(prepared)).resolves.toBe(false);
        expect(await fs.readdir(root)).toEqual(["result.txt"]);
      }
    },
  );

  it.each(["remote", "local", "owner"] as const)(
    "rejects a late %s change after renewal without accepting the result",
    async (side) => {
      let current = true;
      let remoteChanged = false;
      const f = await prepareUnchangedWorkspace({
        assertCurrent: () => {
          if (!current) {
            throw new Error("stale result owner");
          }
        },
        onRenew: async (root) => {
          if (side === "local") {
            await fs.writeFile(path.join(root, "result.txt"), "late local write\n");
          } else if (side === "remote") {
            remoteChanged = true;
          }
        },
        beforeRemoteFence: async () => {
          if (side === "owner") {
            current = false;
          }
          if (remoteChanged) {
            throw new Error("late remote write");
          }
        },
      });
      const final = verifyReconciledWorkspaceFinal(f.reconciliation, f.quiescence);
      if (side === "owner") {
        await expect(final).rejects.toThrow("stale result owner");
      } else {
        await expect(final).rejects.toMatchObject({ reclaimDisposition: "retry" });
      }
      expect(f.journal.commit).not.toHaveBeenCalled();
      expect(f.record).not.toHaveBeenCalled();
      if (side !== "owner") {
        for (const stagedResultRef of [f.ref, preparedWorkerWorkspaceResultRef(f.ref)]) {
          await expect(
            hasWorkerWorkspaceResultRef({ root: f.root, stagedResultRef }),
          ).resolves.toBe(false);
        }
      }
    },
  );
});
