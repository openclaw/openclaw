import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { validateSkillProposalRecord } from "../skills/workshop/store-record.js";
import { readAppliedSkillProposalEvents } from "../skills/workshop/store-sqlite-event.js";
import type { SkillProposalEvent } from "../skills/workshop/types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import type { LegacyWorkshopProposal } from "./doctor-skill-workshop-relocation.js";

export function readWorkshopMigrationRecordsInDatabase(
  database: DatabaseSync,
  includeEvents: boolean,
) {
  let records: LegacyWorkshopProposal[] = [];
  let appliedEvents: SkillProposalEvent[] = [];
  if (tableExists(database, "skill_workshop_proposals")) {
    const kysely =
      getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(database);
    const rows = executeSqliteQuerySync(
      database,
      kysely.selectFrom("skill_workshop_proposals").select(["record_json", "owner_agent_id"]),
    ).rows;
    records = rows.flatMap((row) => {
      try {
        const parsed = validateSkillProposalRecord(JSON.parse(row.record_json));
        return parsed.ok ? [{ record: parsed.value, ownerAgentId: row.owner_agent_id }] : [];
      } catch {
        return [];
      }
    });
    if (includeEvents && tableExists(database, "skill_workshop_proposal_events")) {
      appliedEvents = readAppliedSkillProposalEvents(database);
    }
  }
  return { records, appliedEvents };
}
