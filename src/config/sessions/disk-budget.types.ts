import type { SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";
import type { SessionEntry } from "./types.js";

export type SessionDiskBudgetSweepResult = {
  totalBytesBefore: number;
  totalBytesAfter: number;
  removedFiles: number;
  removedEntries: number;
  freedBytes: number;
  maxBytes: number;
  highWaterBytes: number;
  overBudget: boolean;
  deferredReason?: "checkpoint-incomplete";
  checkpoint?: SqliteWalHealth;
  walBytesBefore?: number;
  walBytesAfter?: number;
};

export type SessionUnreferencedArtifactSweepResult = {
  scannedFiles: number;
  removedFiles: number;
  freedBytes: number;
  olderThanMs: number;
};

export type ArchivedSessionEvictionQuery = {
  after?: { archivedAt: number; sessionKey: string };
  limit?: number;
  preserveRecentMs?: number | null;
};

export type ArchivedSessionEvictionBatch = {
  candidates: Array<{ archivedAt: number; entry: SessionEntry; sessionKey: string }>;
  cursor?: { archivedAt: number; sessionKey: string };
  exhausted: boolean;
};
