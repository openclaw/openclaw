import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readAppliedSkillProposalEvents } from "../skills/workshop/store-sqlite-event.js";
import { validateSkillProposalRecord } from "../skills/workshop/store.js";
import type { SkillProposalEvent } from "../skills/workshop/types.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { listLegacyCollectionBackupWorkspaceDirs } from "./doctor-skill-workshop-collection-backups.js";
import {
  classifyWorkshopRelocation,
  type LegacyWorkshopProposal,
} from "./doctor-skill-workshop-relocation.js";

export const LEGACY_WORKSHOP_PROPOSALS_DIR = "skill-workshop/proposals";
export const LEGACY_WORKSHOP_MAX_RECORD_BYTES = 1024 * 1024;
export const LEGACY_WORKSHOP_PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;

export async function readLegacyWorkshopJson(
  rootDir: Root,
  relativePath: string,
  maxBytes: number,
): Promise<unknown> {
  const read = await rootDir.read(relativePath, {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  return JSON.parse(read.buffer.toString("utf8"));
}

export async function readWorkshopMigrationRecords(env: NodeJS.ProcessEnv, includeEvents = false) {
  const stored = await withExistingOpenClawStateDatabaseArtifactPreservingReadOnlyAsync(
    (database) => {
      let records: LegacyWorkshopProposal[] = [];
      let appliedEvents: SkillProposalEvent[] = [];
      if (tableExists(database.db, "skill_workshop_proposals")) {
        const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
          database.db,
        );
        const rows = executeSqliteQuerySync(
          database.db,
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
        if (includeEvents && tableExists(database.db, "skill_workshop_proposal_events")) {
          appliedEvents = readAppliedSkillProposalEvents(database.db);
        }
      }
      return { records, appliedEvents };
    },
    { env },
  );
  return stored ?? { records: [], appliedEvents: [] };
}

export async function listLegacySkillWorkshopWorkspaceDirs(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { records } = await readWorkshopMigrationRecords(env);
  const stateDir = resolveStateDir(env);
  if (await pathExists(path.join(stateDir, LEGACY_WORKSHOP_PROPOSALS_DIR))) {
    const stateRoot = await root(stateDir);
    for (const entry of await stateRoot.list(LEGACY_WORKSHOP_PROPOSALS_DIR, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory || !LEGACY_WORKSHOP_PROPOSAL_ID_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        const parsed = validateSkillProposalRecord(
          await readLegacyWorkshopJson(
            stateRoot,
            `${LEGACY_WORKSHOP_PROPOSALS_DIR}/${entry.name}/proposal.json`,
            LEGACY_WORKSHOP_MAX_RECORD_BYTES,
          ),
        );
        if (parsed.ok && parsed.value.id === entry.name) {
          records.push({ record: parsed.value, ownerAgentId: null });
        }
      } catch {
        // Missing or invalid sidecars cannot establish a workspace; import owns their diagnostics.
      }
    }
  }
  const { external } = classifyWorkshopRelocation(records, config, env);
  return [
    ...new Set([
      ...external.flatMap(({ workspaceDir }) => (workspaceDir ? [workspaceDir] : [])),
      ...(await listLegacyCollectionBackupWorkspaceDirs(env)),
    ]),
  ];
}
