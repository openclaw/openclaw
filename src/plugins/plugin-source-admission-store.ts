import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

/** Deferred publication retains its original store and authority through settlement. */
export function createPluginSourceAdmissionPublisher(
  options: { env?: NodeJS.ProcessEnv; stateDir?: string } = {},
): ((publication: PluginSourceAdmissionPublication) => Promise<boolean>) | undefined {
  if (isArtifactPreservingStateRead()) {
    return undefined;
  }
  let context: ReturnType<typeof captureOpenClawStateWorkerContext>;
  try {
    context = captureOpenClawStateWorkerContext(
      resolveInstalledPluginIndexStateDatabaseOptions(options),
    );
  } catch (error) {
    // Persistence remains advisory; a later retry cannot acquire replacement authority.
    return async () => {
      throw error;
    };
  }
  return async (publication) => {
    if (isArtifactPreservingStateRead()) {
      return false;
    }
    const prepared = structuredClone(publication);
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return (
      (await runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          scope.execute({ type: "plugins.metadata.sourceAdmission.publish", input: prepared }),
        { existingOnly: true },
      )) ?? false
    );
  };
}
