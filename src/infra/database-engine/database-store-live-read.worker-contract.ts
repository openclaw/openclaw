import type { DatabaseStoreDiagnostic } from "./diagnostic-record.js";
import type { BackupEngine } from "./types.js";

/** Leaf contract: the read-only operation registry must not import the live reader's graph. */
export type DatabaseStoreLiveReadOperations = {
  "databaseStore.inspectLive": {
    input: { diagnostic: DatabaseStoreDiagnostic };
    output: { diagnostic: DatabaseStoreDiagnostic; engine: BackupEngine } | undefined;
  };
};
