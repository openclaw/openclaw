import { parentPort } from "node:worker_threads";
import type {
  UpdateCandidatePluginFileReply,
  UpdateCandidatePluginFileRequest,
} from "./update-candidate-plugin-file.js";
import type {
  UpdateCandidatePluginHashReply,
  UpdateCandidatePluginHashRequest,
} from "./update-candidate-plugin-hash.js";

// Internal one-shot subprocess: a hard process deadline can interrupt synchronous
// SQLite inspection, backup/VACUUM, and retained-runtime file verification.
async function snapshotCandidateState(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // SAFETY: Only typed updater launchers serialize this private worker's stdin.
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as UpdateStateInspectionInput;
  const value = await inspectCandidateState(input);
  const { writeUpdateStateResult } = await import("./update-candidate-state.result.js");
  await writeUpdateStateResult(value, input.resultPath);
}

type UpdateStateInspectionInput = { resultPath?: string } & (
  | (Parameters<
      typeof import("./update-retained-runtime-files.js").prepareRetainedRuntimeFiles
    >[0] & {
      mode: "runtime-retention";
    })
  | (Parameters<typeof import("./update-candidate-state.js").snapshotUpdateCandidateState>[0] & {
      mode: "snapshot";
      streamProgress?: boolean;
    })
  | (Parameters<
      typeof import("./update-candidate-state.js").discoverUpdateStateSchemaInspectionInProcess
    >[0] & { mode: "discover" })
  | (Parameters<
      typeof import("./update-candidate-state.js").readUpdateStateSchemaVersionsInProcess
    >[0] & { mode: "versions" })
  | (Parameters<
      typeof import("./update-candidate-state.js").readUpdateCandidateStateInventoryInProcess
    >[0] & {
      mode: "inventory";
      streamProgress?: boolean;
    })
  | (Parameters<
      typeof import("./update-database-backup.js").createUpdateDatabaseBackupInProcess
    >[0] & { mode: "database-backup" })
  | (Parameters<
      typeof import("./update-database-restore-source.js").prepareUpdateDatabaseRestoreSourceInProcess
    >[0] & { mode: "database-restore-preparation" })
  | {
      mode: "database-generations";
      paths: string[];
      stateDir: string;
      generationFormat?: "committed" | "paired";
      pluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
    }
);

async function inspectCandidateState(input: UpdateStateInspectionInput): Promise<unknown> {
  if (input.mode === "runtime-retention") {
    const { prepareRetainedRuntimeFiles } = await import("./update-retained-runtime-files.js");
    return prepareRetainedRuntimeFiles(input);
  }
  if ("stateDir" in input && input.mode !== "database-generations" && input.mode !== "snapshot") {
    // Older installed drivers omit this from their restricted environment payload.
    // Metadata discovery must use the same installation as the inspected databases.
    input.env = { ...input.env, OPENCLAW_STATE_DIR: input.stateDir };
  }
  // Runtime retention needs no database/config inspection graph.
  const { createUpdateStateInspectionReporter } =
    await import("./update-candidate-state.diagnostics.js");
  const {
    discoverUpdateStateSchemaInspectionInProcess,
    readUpdateCandidateStateInventoryInProcess,
    readUpdateStateSchemaVersionsInProcess,
    snapshotUpdateCandidateState,
  } = await import("./update-candidate-state.js");
  switch (input.mode) {
    case "database-restore-preparation": {
      const { prepareUpdateDatabaseRestoreSourceInProcess } =
        await import("./update-database-restore-source.js");
      return prepareUpdateDatabaseRestoreSourceInProcess(input);
    }
    case "database-generations": {
      const { readUpdatePhysicalDatabaseGenerationPair, isLegacyUpdateGenerationRequest } =
        await import("./update-physical-database-generations.js");
      const pair = await readUpdatePhysicalDatabaseGenerationPair(input.paths, input.pluginOwners);
      if (input.generationFormat === "paired") {
        return pair;
      }
      return input.generationFormat === undefined &&
        (await isLegacyUpdateGenerationRequest({
          ...process.env,
          OPENCLAW_STATE_DIR: input.stateDir,
        }))
        ? pair.physical
        : pair.committed;
    }
    case "inventory": {
      const { resolveDatabaseFamilyEngines } = await import("./database-engine/registry.js");
      const { databases, ...inventory } = await readUpdateCandidateStateInventoryInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(!input.streamProgress),
      });
      return {
        ...inventory,
        databases: [...databases],
        // PostgreSQL snapshots retain portable exports alongside their private copies.
        // External stores still follow the global engine when built-in families override it.
        ...(input.config.database?.engine !== "postgres" &&
        !Object.values(resolveDatabaseFamilyEngines(input.config)).includes("postgres")
          ? { snapshotSpace: "single-generation" }
          : {}),
      };
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
        includeLocalStoreVersions: input.includeLocalStoreVersions === true,
        includeClientCredentialStoreVersion: input.includeClientCredentialStoreVersion === true,
        onProgress: createUpdateStateInspectionReporter(!input.streamProgress),
      });
    case "discover":
      return discoverUpdateStateSchemaInspectionInProcess({
        ...input,
        onProgress: createUpdateStateInspectionReporter(),
      });
    case "versions":
      return readUpdateStateSchemaVersionsInProcess({
        ...input,
        includeLocalStoreVersions: input.includeLocalStoreVersions === true,
        includeClientCredentialStoreVersion: input.includeClientCredentialStoreVersion === true,
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
  // Stdout carries only the JSON result; raised console levels must not prefix it.
  const { routeLogsToStderr } = await import("../logging/console.js");
  routeLogsToStderr();
  const { formatUpdateStateInspectionError } =
    await import("./update-candidate-state.diagnostics.js");
  void snapshotCandidateState().catch((error: unknown) => {
    process.stderr.write(formatUpdateStateInspectionError(error));
    process.exitCode = 1;
  });
}
