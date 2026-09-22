import type { SqliteWalHealth } from "../../infra/sqlite-wal-checkpoint.js";

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
