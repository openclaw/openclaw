import { hashFileMutationSnapshotSync, type FileMutationMetadata } from "./file-descriptor.js";
import type { UpdateCandidatePluginFileReply } from "./update-candidate-plugin-file.js";
import { createUpdateCandidatePluginPool } from "./update-candidate-plugin-tasks.js";
import { resolveUpdateHashWorkerCount } from "./worker-pool-sizing.js";
import type { WorkerTaskPool } from "./worker-task-pool.js";

export type UpdateCandidatePluginHashRequest = {
  type: "snapshot-hash";
  filePath: string;
  expected: FileMutationMetadata;
};

export type UpdateCandidatePluginHashReply =
  | { type: "hashed"; sha256: string }
  | Extract<UpdateCandidatePluginFileReply, { type: "failed" }>;

export type UpdateCandidatePluginFileHasher = (
  filePath: string,
  expected: FileMutationMetadata,
) => Promise<string>;

/** The inventory owner drains its four-file read window before retiring these workers. */
export async function withUpdateCandidatePluginFileHashing<T>(
  operation: (hashFile: UpdateCandidatePluginFileHasher) => Promise<T>,
): Promise<T> {
  // Temporary CI diagnostics; remove before production integration.
  const diagnostics = process.env.OPENCLAW_RETAINED_ALIAS_DIAGNOSTICS === "1";
  const started = diagnostics ? performance.now() : 0;
  const admittedMilestones = new Set([1, 256, 1023, 1024, 4096, 16384, 65536]);
  const replyMilestones = new Set([1, 1024, 4096, 16384, 65536]);
  let replies = 0;
  let files = 0;
  const trace = (stage: string) => {
    if (diagnostics) {
      process.stderr.write(
        JSON.stringify({
          phase: "retained-hash",
          stage,
          files,
          replies,
          workers: workers ?? null,
          elapsedMs: Math.round(performance.now() - started),
        }) + "\n",
      );
    }
  };
  let workers: number | undefined;
  let pool:
    | Promise<WorkerTaskPool<UpdateCandidatePluginHashRequest, UpdateCandidatePluginHashReply>>
    | undefined;
  try {
    return await operation(async (filePath, expected) => {
      // Keep small graphs in-process. Discovery still owns listing order and its
      // existing four-file admission bound; workers do only the same pinned hash.
      ++files;
      if (diagnostics && admittedMilestones.has(files)) {
        trace("hash-admitted");
      }
      if (files < 1024) {
        return hashFileMutationSnapshotSync(filePath, expected);
      }
      workers ??= resolveUpdateHashWorkerCount();
      if (files === 1024) {
        trace("hash-mode-selected");
      }
      if (workers === 0) {
        return hashFileMutationSnapshotSync(filePath, expected);
      }
      const firstWorkerTask = files === 1024;
      if (firstWorkerTask) {
        trace("pool-start");
      }
      pool ??= createUpdateCandidatePluginPool<
        UpdateCandidatePluginHashRequest,
        UpdateCandidatePluginHashReply
      >(workers);
      // Transfer only lossless fingerprint fields, not a platform Stats instance.
      const taskPool = await pool;
      if (firstWorkerTask) {
        trace("pool-ready");
      }
      const reply = await taskPool.run(
        {
          type: "snapshot-hash",
          filePath,
          expected: {
            dev: expected.dev,
            ino: expected.ino,
            size: expected.size,
            birthtimeNs: expected.birthtimeNs,
            mtimeNs: expected.mtimeNs,
            ctimeNs: expected.ctimeNs,
            mode: expected.mode,
            uid: expected.uid,
            gid: expected.gid,
          },
        },
        {},
      );
      if (diagnostics) {
        replies++;
        if (replyMilestones.has(replies)) {
          trace("pool-reply");
        }
      }
      switch (reply.type) {
        case "failed":
          throw Object.assign(reply.error, {
            ...(reply.code === undefined ? {} : { code: reply.code }),
            ...(reply.details === undefined ? {} : { details: reply.details }),
          });
        case "hashed":
          return reply.sha256;
        default:
          throw new Error("Unexpected update inventory hash worker reply");
      }
    });
  } finally {
    // No per-file deadline or replay: the inventory drains accepted reads, then
    // joins worker retirement before returning its plan or propagating failure.
    trace("pool-close-start");
    await (await pool)?.close();
    trace("pool-close-completed");
  }
}
