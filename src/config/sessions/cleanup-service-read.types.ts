import type { SessionEntryLifecycleRemoval } from "./session-accessor.lifecycle-types.js";
import type {
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
} from "./session-entry-read.types.js";
import type { SessionEntry } from "./types.js";

export type SessionCleanupReadInput = Pick<
  SessionEntryListWorkerInput,
  "database" | "expectedIdentity" | "continuation"
> & {
  kind: "session-cleanup";
  env: NodeJS.ProcessEnv;
  fixMissing: boolean;
};

export type SessionCleanupReadResult = {
  kind: "session-cleanup";
  source?: SessionEntryListWorkerResult["source"];
  store: Record<string, SessionEntry>;
  missing: SessionEntryLifecycleRemoval[];
};
