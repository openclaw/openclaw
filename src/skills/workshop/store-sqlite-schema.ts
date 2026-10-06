import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase as StateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import type { OpenClawStateAsyncLeaseContext } from "../../state/openclaw-state-lease-context.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

export type SkillWorkshopDatabase = Pick<
  OpenClawStateDatabase,
  | "skill_workshop_proposal_events"
  | "skill_workshop_proposal_rollbacks"
  | "skill_workshop_proposals"
  | "skill_workshop_collection_reviews"
>;
export type SkillProposalRow = Selectable<SkillWorkshopDatabase["skill_workshop_proposals"]>;
export type SkillWorkshopStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  agentId?: string;
  config?: OpenClawConfig;
  execution?: {
    context: OpenClawStateWorkerContext;
    leases: readonly OpenClawStateAsyncLeaseContext[];
  };
};
export type SkillWorkshopDirectoryStoreOptions = SkillWorkshopStoreOptions & {
  config: OpenClawConfig;
};

const SCHEMA_SQL = [
  ...[
    "skill_workshop_proposals",
    "skill_workshop_collection_reviews",
    "skill_workshop_proposal_rollbacks",
    "skill_workshop_proposal_events",
  ].map((table) => extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, table)),
  `CREATE INDEX IF NOT EXISTS idx_skill_workshop_proposal_events_proposal
  ON skill_workshop_proposal_events(proposal_id, sequence);`,
].join("\n");
const ensuredDatabases = new WeakSet<DatabaseSync>();

export function databaseOptions(
  options: SkillWorkshopStoreOptions = {},
): OpenClawStateDatabaseOptions {
  if (options.stateDir) {
    return {
      ...(options.env ? { env: options.env } : {}),
      path: path.join(path.resolve(options.stateDir), "state", "openclaw.sqlite"),
    };
  }
  return options.env ? { env: options.env } : {};
}

export function ensureSkillWorkshopSchemaInDatabase(
  database: StateDatabase,
  dbOptions: OpenClawStateDatabaseOptions,
  assertWrite?: (database: DatabaseSync, stage: "transaction" | "commit") => void,
): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertWrite?.(db, "transaction");
      // sqlite-allow-raw -- Feature-local additive schema DDL; proposal rows use Kysely.
      db.exec(SCHEMA_SQL);
      assertWrite?.(db, "commit");
    },
    dbOptions,
    { operationLabel: "skill-workshop.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}
