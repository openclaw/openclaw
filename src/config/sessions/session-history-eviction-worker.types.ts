import type {
  ArchivedSessionEvictionBatch,
  ArchivedSessionEvictionQuery,
} from "./disk-budget.types.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.js";

type DatabaseTarget = { database: { agentId: string; path: string }; env: NodeJS.ProcessEnv };
type ReaderInput<Input> = Omit<Input, "kind" | "database">;

export type HistoricalInput = DatabaseTarget & {
  kind: "historical-eviction-candidates";
  admissionIdentities: readonly string[];
  preserveRecentMs?: number | null;
};
export type ArchivedInput = DatabaseTarget & {
  kind: "historical-eviction-candidates";
  archived: ArchivedSessionEvictionQuery;
};
export type HistoricalValue = { kind: "historical-eviction-candidates" } & (
  | { sessionIds: string[] }
  | { batch: ArchivedSessionEvictionBatch }
);

export type LiveEvictionPlanInput = {
  archiveDirectory: string;
  preserveRecentMs: number | null;
  skipSessionKeys: readonly string[];
  /** Captured on the Gateway thread; provider and admission state is process-local. */
  snapshot: SessionMaintenancePreservationSnapshot;
  unprotectSessionKeys: readonly string[];
};
export type LiveEvictionPlan = {
  /** Victim key, entry id, and generation ids; empty when no victim was found. */
  identities: string[];
  plan: SessionEntryMaintenancePlan;
};
export type LiveInput = DatabaseTarget & { kind: "live-eviction"; plan: LiveEvictionPlanInput };
export type LiveValue = { kind: "live-eviction"; live: LiveEvictionPlan };

export type Readers = {
  readHistoricalEvictionCandidates: (input: ReaderInput<HistoricalInput>) => Promise<string[]>;
  readArchivedEvictionCandidates: (
    input: ReaderInput<ArchivedInput>,
  ) => Promise<ArchivedSessionEvictionBatch>;
  readLiveEvictionPlan: (input: ReaderInput<LiveInput>) => Promise<LiveEvictionPlan>;
};
