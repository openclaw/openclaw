import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { splitNullBuffer } from "../../agents/worktrees/git-path-inventory.js";
import { requireGitBuffer } from "../../agents/worktrees/git.js";
import type { LocalWorkspaceProjection, localWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import type { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  workerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

/** Git preserves ordinary files, not accepted ignored leaves or empty dirs.
 * Keep only that missing delta in the existing projection recovery receipt. */
async function stageLocalWorkspaceArchive(params: {
  root: string;
  projection: string;
  snapshot: string;
  accepted: WorkerWorkspaceManifest;
  acceptedRef: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  reserve: (base: string, baseRef: string, resultRef: string) => void;
}) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.snapshot)) {
    throw new Error("Invalid archive snapshot commit");
  }
  const listed = await requireGitBuffer(
    params.root,
    ["ls-tree", "-r", "-z", "--name-only", params.snapshot],
    {
      signal: params.signal,
      beforeRun: params.assertCurrent,
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
  params.assertCurrent();
  const paths = new Set(splitNullBuffer(listed).map((entry) => entry.toString("hex")));
  const entries = params.accepted.entries.filter((entry) =>
    paths.has(Buffer.from(entry.path).toString("hex")),
  );
  const directories = new Set<string>();
  for (const entry of entries) {
    for (
      let parent = path.posix.dirname(entry.path);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      directories.add(parent);
    }
  }
  const base = serializeWorkerWorkspaceManifest({
    ...params.accepted,
    entries,
    directories: [...directories].toSorted(),
  });
  const baseRef = "sha256:" + createHash("sha256").update(base).digest("hex");
  if (baseRef === params.acceptedRef) {
    return;
  }
  const resultRef = workerWorkspaceResultRef(randomUUID());
  // Reservation precedes the Git effect. Interrupted staging recaptures the
  // still-owned projection against this same reduced base on ordinary recovery.
  params.reserve(base, baseRef, resultRef);
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: params.root,
    stagingRoot: params.projection,
    stagedResultRef: resultRef,
    baseManifestRaw: base,
    baseManifestRef: baseRef,
    currentManifestRaw: serializeWorkerWorkspaceManifest(params.accepted),
    currentManifestRef: params.acceptedRef,
  });
  params.assertCurrent();
}

export function localWorkspaceArchiveOperations(params: {
  owner: LocalWorkspaceOwner;
  signal: AbortSignal;
  current: () => LocalWorkspaceProjection;
  update: (patch: Parameters<ReturnType<typeof localWorkspaceStore>["update"]>[1]) => void;
  capture: (target: "canonical" | "projection") => ReturnType<typeof captureWorkspaceSnapshot>;
  settle: (retainAccepted?: boolean) => Promise<void>;
  recover: () => Promise<void>;
  cleanupAccepted: () => Promise<void>;
  assertDirectory: (directory: string) => Promise<void>;
  deleteBinding: () => void;
}) {
  const {
    owner,
    signal,
    current,
    update,
    capture,
    settle,
    recover,
    cleanupAccepted,
    assertDirectory: assertOwnedDirectory,
    deleteBinding,
  } = params;
  return {
    restoreSnapshot: async () => {
      await recover();
      const selected = current();
      if (!selected.pending_ref) {
        return;
      }
      if (!selected.pending_target) {
        // A failed restore may have applied the overlay before its checkout was
        // rolled back. Retain and replay the same accepted receipt on retry.
        const receipt = await readStagedWorkerWorkspaceResult(
          owner.worktree.repoRoot,
          selected.pending_ref,
        );
        current();
        if (receipt.currentManifestRef !== selected.baseline_ref) {
          throw new Error("Archive restore receipt changed");
        }
        update({
          baseline_json: serializeWorkerWorkspaceManifest(receipt.base),
          baseline_ref: receipt.baseManifestRef,
          pending_target: "canonical",
        });
      }
      await settle(true);
    },
    finishRestore: cleanupAccepted,
    prepareArchive: async (snapshotCommit: string) => {
      await settle();
      const accepted = await capture("canonical");
      if (accepted.manifestRef !== current().baseline_ref) {
        throw new Error("Local workspace changed before archive capture");
      }
      await stageLocalWorkspaceArchive({
        root: owner.worktree.repoRoot,
        projection: current().projection_path,
        snapshot: snapshotCommit,
        accepted: accepted.manifest,
        acceptedRef: accepted.manifestRef,
        signal,
        assertCurrent: () => {
          current();
        },
        reserve: (base, baseRef, resultRef) => {
          update({
            baseline_json: base,
            baseline_ref: baseRef,
            pending_ref: resultRef,
            pending_target: "canonical",
          });
        },
      });
    },
    expire: async (retireSnapshot?: (assertCurrent: () => void) => Promise<void>) => {
      const selected = current();
      if (
        selected.journal_json ||
        (selected.pending_target && selected.pending_target !== "canonical")
      ) {
        throw new Error("Local sandbox has pending edits; restore its worktree before cleanup");
      }
      let accepted =
        selected.baseline_json && selected.baseline_ref
          ? { raw: selected.baseline_json, ref: selected.baseline_ref }
          : undefined;
      if (selected.pending_ref) {
        if (!retireSnapshot || owner.worktree.removedAt === undefined) {
          throw new Error("Archive receipt still owns its restore data");
        }
        if (selected.pending_target) {
          const receipt = await readStagedWorkerWorkspaceResult(
            owner.worktree.repoRoot,
            selected.pending_ref,
          );
          current();
          if (receipt.baseManifestRef !== selected.baseline_ref) {
            throw new Error("Archive retention receipt changed");
          }
          accepted = {
            raw: serializeWorkerWorkspaceManifest(receipt.current),
            ref: receipt.currentManifestRef,
          };
        }
      }
      if (accepted && (await capture("canonical")).manifestRef !== accepted.ref) {
        throw new Error("Local sandbox has unaccepted edits; restore its worktree before cleanup");
      }
      const { readLocalWorkspaceRuntimes } =
        await import("../../agents/sandbox/local-workspace-quiescence.js");
      if ((await readLocalWorkspaceRuntimes(selected.projection_path)).length) {
        throw new Error("Local sandbox runtime still owns its workspace; cleanup deferred");
      }
      const parent = path.dirname(selected.projection_path);
      await assertOwnedDirectory(parent);
      current();
      // Once expiry starts, an older restore must not find a usable Git snapshot
      // after its accepted overlay has been retired.
      await retireSnapshot?.(() => {
        current();
      });
      current();
      if (selected.pending_ref && accepted) {
        update({ baseline_json: accepted.raw, baseline_ref: accepted.ref, pending_target: null });
        await cleanupAccepted();
      }
      await fs.rm(parent, { recursive: true, force: true });
      deleteBinding();
    },
  };
}
