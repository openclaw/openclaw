import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { insertProposal } from "./store-sqlite-record.js";
import { writeSkillProposalRollbackInDatabase } from "./store-sqlite-rollback.js";
import { databaseOptions, type SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import type { SkillProposalRecord, SkillProposalRollback } from "./types.js";

/** Seeds retained records without publishing draft files or lifecycle events. */
export function seedSkillProposal(params: {
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
  ownerAgentId: string;
  store?: SkillWorkshopStoreOptions;
}): void {
  const options = databaseOptions(params.store);
  const database = openOpenClawStateDatabase(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      insertProposal(db, params);
      if (params.rollback) {
        writeSkillProposalRollbackInDatabase(db, {
          proposalId: params.record.id,
          rollback: params.rollback,
        });
      }
    },
    { ...options, database },
  );
}
