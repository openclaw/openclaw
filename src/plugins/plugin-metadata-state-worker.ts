import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  readPluginMetadataStateRowSync,
  type PluginMetadataStateSelector,
} from "./installed-plugin-index-row.js";
import { PluginCacheFactInvalidatedError } from "./plugin-cache.js";

/** Read raw metadata from retained snapshot bytes or the shared inspection actor. */
export async function readPluginMetadataStateRow(
  selector: PluginMetadataStateSelector,
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<{ value_json: string } | undefined> {
  const preserveArtifacts = artifactPreservingReadOnly || isArtifactPreservingStateRead();
  try {
    const context = captureOpenClawStateWorkerContext(options);
    try {
      if (preserveArtifacts && getActiveOpenClawStateDatabaseReadSnapshot(options)) {
        context.admission.assertCurrent();
        return readPluginMetadataStateRowSync(selector, options, true);
      }
      const { runOpenClawStateWorkerOperation } =
        await import("../state/openclaw-state-worker-store.js");
      context.admission.assertCurrent();
      return await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          const row = await scope.execute({
            type: "plugins.metadata.read",
            input: { selector, artifactPreservingReadOnly: preserveArtifacts },
          });
          if (row === undefined) {
            return undefined;
          }
          if (!isRecord(row) || typeof row.value_json !== "string") {
            throw new Error("Shared-state worker returned an invalid plugin metadata row");
          }
          return { value_json: row.value_json };
        },
        { existingOnly: true },
      );
    } finally {
      context.admission.assertCurrent();
    }
  } catch (error) {
    if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw new PluginCacheFactInvalidatedError(
        "Plugin metadata read admission changed during preparation; retry the operation.",
        { cause: error },
      );
    }
    throw error;
  }
}
