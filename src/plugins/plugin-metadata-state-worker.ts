import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  readPluginMetadataStateRowSync,
  readPluginMetadataStateRowsSync,
  type PluginMetadataStateKey,
  type PluginMetadataStateRow,
  type PluginMetadataStateSelector,
} from "./installed-plugin-index-row.js";
import { PluginCacheFactInvalidatedError } from "./plugin-cache.js";

async function readPluginMetadataState<T>(
  selection:
    | { selector: PluginMetadataStateSelector }
    | { stateKeys: readonly PluginMetadataStateKey[] },
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly: boolean,
  decode: (value: unknown) => T,
): Promise<T> {
  const preserveArtifacts = artifactPreservingReadOnly || isArtifactPreservingStateRead();
  try {
    const context = captureOpenClawStateWorkerContext(options);
    try {
      if (preserveArtifacts && getActiveOpenClawStateDatabaseReadSnapshot(options)) {
        context.admission.assertCurrent();
        return decode(
          "stateKeys" in selection
            ? readPluginMetadataStateRowsSync(selection.stateKeys, options, true)
            : readPluginMetadataStateRowSync(selection.selector, options, true),
        );
      }
      const { runOpenClawStateWorkerOperation } =
        await import("../state/openclaw-state-worker-store.js");
      context.admission.assertCurrent();
      const result = await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          return decode(
            await scope.execute({
              type: "plugins.metadata.read",
              input: { ...selection, artifactPreservingReadOnly: preserveArtifacts },
            }),
          );
        },
        { existingOnly: true },
      );
      return result === undefined ? decode(undefined) : result;
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

/** Read raw metadata from retained snapshot bytes or the shared inspection actor. */
export function readPluginMetadataStateRow(
  selector: PluginMetadataStateSelector,
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<{ value_json: string } | undefined> {
  return readPluginMetadataState({ selector }, options, artifactPreservingReadOnly, (row) => {
    if (row === undefined) {
      return undefined;
    }
    if (!isRecord(row) || typeof row.value_json !== "string") {
      throw new Error("Shared-state worker returned an invalid plugin metadata row");
    }
    return { value_json: row.value_json };
  });
}

/** Policy and inventory preparation share one worker request and SQLite snapshot. */
export function readPluginMetadataStateRows(
  stateKeys: readonly PluginMetadataStateKey[],
  options: { path?: string; env?: NodeJS.ProcessEnv },
  artifactPreservingReadOnly = false,
): Promise<PluginMetadataStateRow[]> {
  return readPluginMetadataState({ stateKeys }, options, artifactPreservingReadOnly, (rows) => {
    if (rows === undefined) {
      return [];
    }
    if (!Array.isArray(rows)) {
      throw new Error("Shared-state worker returned invalid plugin metadata rows");
    }
    return rows.map((row) => {
      if (
        !isRecord(row) ||
        typeof row.state_key !== "string" ||
        typeof row.value_json !== "string"
      ) {
        throw new Error("Shared-state worker returned an invalid plugin metadata row");
      }
      return { state_key: row.state_key, value_json: row.value_json };
    });
  });
}
