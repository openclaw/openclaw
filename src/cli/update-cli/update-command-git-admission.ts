import { inspectSourceUpdateArtifacts } from "../../../scripts/lib/source-update-artifact-preflight.mts";
import { formatErrorMessage } from "../../infra/errors.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";

export async function admitSourceUpdateArtifacts(
  root: string,
  run: UpdateCommandOptions["run"],
): Promise<boolean> {
  try {
    const prepared = await inspectSourceUpdateArtifacts(root);
    if (prepared.lock && !run) {
      await prepared.lock.release();
      throw new Error("Source artifact admission requires an active update run.");
    }
    if (run) {
      run.sourceArtifactLock = prepared.lock;
    }
    return prepared.sourceRuntimePrepared;
  } catch (cause) {
    throw new UpdatePreMutationError("source-artifact-ownership", formatErrorMessage(cause), {
      cause,
    });
  }
}
