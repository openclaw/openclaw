import { pluginCohortPublicationContext } from "../infra/update-plugin-cohort-context.js";
import type { PluginCohortConfigFileIntent } from "../infra/update-plugin-cohort-schema.js";
import type { ConfigFileWritePathSnapshot } from "./io.write-path.types.js";
import type { ConfigFileSnapshot } from "./types.js";

/** The root writer publishes the snapshot's authored bytes at its pinned target. */
export function prepareRootPluginCohortIntent(
  snapshot: Pick<ConfigFileSnapshot, "path" | "raw">,
  pathSnapshot: ConfigFileWritePathSnapshot,
  afterRaw: string,
  assertCurrent: () => void,
): void {
  preparePluginCohortConfigPublication(
    {
      rootConfigPath: snapshot.path,
      filePath: snapshot.path,
      targetPath: pathSnapshot.targetPath,
      pathSnapshot,
      beforeRaw: snapshot.raw,
      afterRaw,
    },
    assertCurrent,
  );
}

/** Record before publication without importing the recovery writer into physical config IO. */
export function preparePluginCohortConfigPublication(
  file: PluginCohortConfigFileIntent,
  assertWriterCurrent: () => void,
): void {
  const capture = pluginCohortPublicationContext.getStore();
  if (!capture || file.beforeRaw === file.afterRaw) {
    return;
  }
  capture.prepareConfigPublication(file, assertWriterCurrent);
}
