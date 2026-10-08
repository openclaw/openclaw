import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDirectoryIdentitySync, type DirectoryIdentity } from "@openclaw/fs-safe/advanced";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { hashFileMutationSnapshotSync } from "./file-descriptor.js";
import type { Root } from "./fs-safe.js";
import { assertUpdateCandidatePluginEntryStat } from "./update-candidate-plugin-tree-links.js";
import type { UpdateCandidatePluginEntry } from "./update-candidate-plugin-tree-schema.js";

export type UpdateCandidatePluginFileRequest = {
  privateRoot: string;
  rootIdentity: DirectoryIdentity;
  destination: string;
  entry: Extract<UpdateCandidatePluginEntry, { kind: "file" }>;
};

export type UpdateCandidatePluginFileReply =
  | { type: "copied" }
  | { type: "failed"; error: Error; code?: string; details?: unknown };

/** Keep identical inventory, containment, and byte checks in both execution paths. */
export async function copyUpdateCandidatePluginFile(
  request: UpdateCandidatePluginFileRequest,
  destinationRoot: Root,
): Promise<void> {
  const { entry, privateRoot, rootIdentity } = request;
  const assertEntry = async () =>
    assertUpdateCandidatePluginEntryStat(entry, await fs.lstat(entry.path, { bigint: true }));
  await assertEntry();
  await copyUpdateCandidatePluginFileBytes(request, destinationRoot, {
    // A worker must retain the parent's admitted root, not admit a newer one.
    assertBeforeMutation: () => assertDirectoryIdentitySync(privateRoot, rootIdentity),
    assertAfterCopy: assertEntry,
  });
}

/** Shared byte publication; each owner supplies its live authority and post-copy inspection. */
export async function copyUpdateCandidatePluginFileBytes(
  { entry, privateRoot, destination }: Omit<UpdateCandidatePluginFileRequest, "rootIdentity">,
  destinationRoot: Root,
  checks: { assertBeforeMutation: () => void; assertAfterCopy: () => Promise<void> },
): Promise<void> {
  await destinationRoot.copyIn(path.relative(privateRoot, destination), entry.path, {
    overwrite: false,
    // The owner prepares every parent before admitting any concurrent copies.
    mkdir: false,
    // These are disposable rehearsal payloads, never recovery backups.
    durable: false,
    clone: "auto",
    maxBytes: entry.size,
    mode: entry.mode | 0o600,
    sourceHardlinks: "allow",
    assertBeforeMutation: () => {
      checks.assertBeforeMutation();
      assertUpdateCandidatePluginEntryStat(entry, fsSync.lstatSync(entry.path, { bigint: true }));
    },
  });
  await checks.assertAfterCopy();
  const copiedStat = await fs.lstat(destination, { bigint: true });
  if (hashFileMutationSnapshotSync(destination, copiedStat) !== entry.sha256) {
    throw new Error(`Copied plugin bytes differ from snapshot inventory: ${entry.path}`);
  }
}

/** Drain the complete file phase before the tree owner can publish links or clean up. */
export async function copyUpdateCandidatePluginFiles(
  files: readonly UpdateCandidatePluginFileRequest["entry"][],
  params: {
    privateRoot: string;
    rootIdentity: DirectoryIdentity;
    destinationRoot: Root;
    destinationFor: (source: string) => string;
    onProgress?: () => void;
  },
): Promise<void> {
  const { privateRoot, rootIdentity, destinationRoot, destinationFor } = params;
  // Guarded publication and hashing contain synchronous work. Promise concurrency
  // alone leaves large snapshots on one CPU; retain the four-file admission bound
  // while sharing that work across snapshot-owned isolates.
  const pool =
    files.length >= 1024
      ? await (async () => {
          const [{ WorkerTaskPool }, { resolveRuntimeProcessEntrypointUrl }] = await Promise.all([
            import("./worker-task-pool.js"),
            import("./runtime-process-url.js"),
          ]);
          return new WorkerTaskPool<
            UpdateCandidatePluginFileRequest,
            UpdateCandidatePluginFileReply
          >({
            workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
            workerClass: "compute",
            maxPendingTasks: 4,
            restartOnError: false,
          });
        })()
      : undefined;
  try {
    const copied = await runTasksWithConcurrency({
      limit: 4,
      errorMode: "stop",
      tasks: files.map((entry) => async () => {
        const request = {
          entry,
          privateRoot,
          rootIdentity,
          destination: destinationFor(entry.path),
        };
        if (!pool) {
          await copyUpdateCandidatePluginFile(request, destinationRoot);
        } else {
          // The enclosing subprocess owns the deadline. Never terminate or replay
          // a file writer on an independent task timer.
          const reply = await pool.run(request, {});
          if (reply.type === "failed") {
            throw Object.assign(reply.error, {
              ...(reply.code === undefined ? {} : { code: reply.code }),
              ...(reply.details === undefined ? {} : { details: reply.details }),
            });
          }
        }
        params.onProgress?.();
      }),
    });
    if (copied.hasError) {
      throw copied.firstError;
    }
  } finally {
    // The task runner drains accepted copies before retirement; snapshot cleanup
    // must wait for both the work and confirmed worker exits.
    await pool?.close();
  }
}
