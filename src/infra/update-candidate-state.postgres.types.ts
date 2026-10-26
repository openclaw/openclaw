import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import type { UpdateCandidatePluginIndex } from "./update-candidate-plugins.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";
import type { StateInput } from "./update-candidate-state.shared.js";

export type UpdatePostgresStateInput = StateInput;
export type UpdatePostgresStateTask = {
  input: UpdatePostgresStateInput;
  files: [string, StateDatabaseDiscovery][];
  sourcePath?: string;
};
export type UpdatePostgresStateReply = {
  files: UpdatePostgresStateTask["files"];
  version: Omit<UpdateStateSchemaVersion, "path"> & { userVersion: number };
  pluginIndex?: UpdateCandidatePluginIndex;
};
