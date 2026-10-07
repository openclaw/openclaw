import { isDeepStrictEqual } from "node:util";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { readAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import { digestClawValue } from "./digest.js";
import type { ClawPortableRemovalPrecondition } from "./portable-heartbeat-removal.types.js";
import {
  portableHeartbeatDrift,
  portableHeartbeatStateDigest,
  readPortableHeartbeatStateInDatabase,
} from "./portable-heartbeat-state.kernel.js";
import { readClawInstallRecordFromDatabase } from "./provenance-read.kernel.js";

/** Called under Cron's writer transaction; only its live lease needs rechecking after deletion. */
export function prepareClawPortableRemoval(
  database: OpenClawStateDatabase,
  storePath: string,
  input: ClawPortableRemovalPrecondition,
): () => void {
  const { deletion } = input;
  if (
    deletion.databasePath !== database.path ||
    deletion.agentId !== input.agentId ||
    deletion.lease.scope !== "core:agent-deletion" ||
    deletion.lease.key !== input.agentId
  ) {
    throw new Error("Portable automation removal differs from its deletion owner.");
  }
  const assertCurrent = () => {
    if (
      !isDeepStrictEqual(requireOpenClawStateDatabaseIdentity(database), deletion.sourceIdentity)
    ) {
      throw new Error("Portable removal no longer owns its original physical database.");
    }
    assertExistingDatabaseIdentity(
      database.path,
      deletion.sourceIdentity.key,
      deletion.sourceIdentity.birthtime,
    );
    verifyOpenClawStateLeaseOwnership({
      ...deletion.lease,
      leaseLabel: "agent deletion",
      transaction: database.db,
    });
  };
  assertCurrent();
  const journal = readAgentDeletionJournalInDatabase(database, input.agentId);
  const current = readPortableHeartbeatStateInDatabase(database.db, input.agentId, storePath);
  if (
    !journal ||
    journal.operationId !== deletion.operationId ||
    journal.cleanupCompleted ||
    digestClawValue(readClawInstallRecordFromDatabase(database.db, input.agentId) ?? null) !==
      input.expectedInstallDigest ||
    current.job?.id !== input.jobId ||
    portableHeartbeatDrift(current) ||
    portableHeartbeatStateDigest(current) !== input.expectedStateDigest
  ) {
    throw new Error("Portable automation ownership changed before removal; rebuild the Claw plan.");
  }
  return assertCurrent;
}
