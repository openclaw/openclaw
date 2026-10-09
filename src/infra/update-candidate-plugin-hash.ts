import { hashFileMutationSnapshotSync, type FileMutationMetadata } from "./file-descriptor.js";
import type { UpdateCandidatePluginFileReply } from "./update-candidate-plugin-file.js";
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
  let files = 0;
  let workers: number | undefined;
  let pool:
    | Promise<WorkerTaskPool<UpdateCandidatePluginHashRequest, UpdateCandidatePluginHashReply>>
    | undefined;
  try {
    return await operation(async (filePath, expected) => {
      // Keep small graphs in-process. Discovery still owns listing order and its
      // existing four-file admission bound; workers do only the same pinned hash.
      if (++files < 1024) {
        return hashFileMutationSnapshotSync(filePath, expected);
      }
      workers ??= resolveUpdateHashWorkerCount();
      if (workers === 0) {
        return hashFileMutationSnapshotSync(filePath, expected);
      }
      pool ??= (async () => {
        const [{ WorkerTaskPool }, { resolveRuntimeProcessEntrypointUrl }] = await Promise.all([
          import("./worker-task-pool.js"),
          import("./runtime-process-url.js"),
        ]);
        return new WorkerTaskPool<UpdateCandidatePluginHashRequest, UpdateCandidatePluginHashReply>(
          {
            workerUrl: resolveRuntimeProcessEntrypointUrl("updateCandidateState"),
            maxWorkers: workers,
            maxPendingTasks: 4,
            restartOnError: false,
          },
        );
      })();
      // Transfer only lossless fingerprint fields, not a platform Stats instance.
      const reply = await (
        await pool
      ).run(
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
    await (await pool)?.close();
  }
}
