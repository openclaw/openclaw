import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";

export type PluginSnapshotCandidateOperation = {
  "plugins.metadata.index.snapshotCandidates": {
    input: {
      identity: OpenClawStateLeaseIdentity;
      operation: "read" | "retain" | "release";
      candidates: PluginSourceSnapshotDescriptor[];
    };
    output: PluginSourceSnapshotDescriptor[];
  };
};
