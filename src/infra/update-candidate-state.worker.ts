import { parentPort } from "node:worker_threads";
import type {
  UpdateCandidatePluginFileReply,
  UpdateCandidatePluginFileRequest,
} from "./update-candidate-plugin-file.js";
import type {
  UpdateCandidatePluginHashReply,
  UpdateCandidatePluginHashRequest,
} from "./update-candidate-plugin-hash.js";

// Internal one-shot subprocess: a hard process deadline can interrupt SQLite
// integrity checks and backup/VACUUM, which expose no AbortSignal contract.
async function snapshotCandidateState(): Promise<unknown> {
  // File workers must not retain the subprocess's database/config inspection graph.
  const { createUpdateStateInspectionReporter } =
    await import("./update-candidate-state.diagnostics.js");
  const {
    discoverUpdateStateSchemaInspectionInProcess,
    readUpdateCandidateStateInventoryInProcess,
    readUpdateStateSchemaVersionsInProcess,
    snapshotUpdateCandidateState,
  } = await import("./update-candidate-state.js");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // SAFETY: Only the updater's typed state inspection launchers serialize this private worker's stdin.
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
    | (Parameters<typeof snapshotUpdateCandidateState>[0] & {
        mode: "snapshot";
        streamProgress?: boolean;
        streamEntryProgress?: boolean;
      })
    | (Parameters<typeof discoverUpdateStateSchemaInspectionInProcess>[0] & { mode: "discover" })
    | (Parameters<typeof readUpdateStateSchemaVersionsInProcess>[0] & { mode: "versions" })
    | (Parameters<typeof readUpdateCandidateStateInventoryInProcess>[0] & {
        mode: "inventory";
        streamProgress?: boolean;
        streamEntryProgress?: boolean;
      })
    | (Parameters<
        typeof import("./update-database-backup.js").createUpdateDatabaseBackupInProcess
      >[0] & { mode: "database-backup" })
    | (Parameters<
        typeof import("./update-database-restore-source.js").prepareUpdateDatabaseRestoreSourceInProcess
      >[0] & { mode: "database-restore-preparation" })
    | { mode: "database-generations"; paths: string[] };
  switch (input.mode) {
    case "database-restore-preparation": {
      const { prepareUpdateDatabaseRestoreSourceInProcess } =
        await import("./update-database-restore-source.js");
      return prepareUpdateDatabaseRestoreSourceInProcess(input);
    }
    case "database-generations": {
      const { readUpdateDatabaseGenerations } = await import("./update-database-generations.js");
      return readUpdateDatabaseGenerations(input.paths);
    }
    case "inventory": {
      const { databases, ...inventory } = await readUpdateCandidateStateInventoryInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(
          !input.streamProgress,
          input.streamEntryProgress,
        ),
      });
      return { ...inventory, databases: [...databases] };
    }
    case "database-backup": {
      const { createUpdateDatabaseBackupInProcess } = await import("./update-database-backup.js");
      return createUpdateDatabaseBackupInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(),
      });
    }
    case "snapshot":
      return snapshotUpdateCandidateState({
        ...input,
        onProgress: createUpdateStateInspectionReporter(
          !input.streamProgress,
          input.streamEntryProgress,
        ),
      });
    case "discover":
      return discoverUpdateStateSchemaInspectionInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(),
      });
    case "versions":
      return readUpdateStateSchemaVersionsInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(!input.inspectionPlan),
      });
    default:
      throw new Error("Unknown update state inspection mode");
  }
}

if (parentPort) {
  const { assertDirectoryIdentitySync } = await import("@openclaw/fs-safe/advanced");
  const { root } = await import("./fs-safe.js");
  const { copyUpdateCandidatePluginFile } = await import("./update-candidate-plugin-file.js");
  const { hashFileMutationSnapshotSync } = await import("./file-descriptor.js");
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  let destination: { path: string; root: Awaited<ReturnType<typeof root>> } | undefined;
  serveWorkerTasks<UpdateCandidatePluginFileReply | UpdateCandidatePluginHashReply>(
    async (input, _channel, control) =>
      control.runNativeSection(
        async (): Promise<UpdateCandidatePluginFileReply | UpdateCandidatePluginHashReply> => {
          // SAFETY: The snapshot owner supplies its inventoried file and original root identity.
          const request = input as
            | UpdateCandidatePluginFileRequest
            | UpdateCandidatePluginHashRequest;
          try {
            if ("type" in request) {
              return {
                type: "hashed",
                sha256: hashFileMutationSnapshotSync(request.filePath, request.expected),
              };
            }
            assertDirectoryIdentitySync(request.privateRoot, request.rootIdentity);
            if (destination?.path !== request.privateRoot) {
              destination = { path: request.privateRoot, root: await root(request.privateRoot) };
            }
            assertDirectoryIdentitySync(request.privateRoot, request.rootIdentity);
            await copyUpdateCandidatePluginFile(request, destination.root);
            return { type: "copied" };
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error : new Error(String(error)),
              ...(error instanceof Error && "code" in error && typeof error.code === "string"
                ? { code: error.code }
                : {}),
              ...(error instanceof Error && "details" in error ? { details: error.details } : {}),
            };
          }
        },
      ),
  );
} else {
  const { formatUpdateStateInspectionError } =
    await import("./update-candidate-state.diagnostics.js");
  void snapshotCandidateState()
    .then((value) => process.stdout.write(JSON.stringify(value)))
    .catch((error: unknown) => {
      process.stderr.write(formatUpdateStateInspectionError(error));
      process.exitCode = 1;
    });
}
