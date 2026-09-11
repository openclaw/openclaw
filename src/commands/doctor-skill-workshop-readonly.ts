import path from "node:path";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists, root } from "../infra/fs-safe.js";
import {
  resolveSkillProposalTarget,
  validateSkillProposalRecord,
} from "../skills/workshop/store.js";
import {
  inspectWorkshopAutomationReferences,
  type WorkshopAutomationReference,
} from "./doctor-skill-workshop-automations.js";
import { listPendingLegacyCollectionBackupRoots } from "./doctor-skill-workshop-collection-backups.js";
import { classifyWorkshopRelocation } from "./doctor-skill-workshop-relocation.js";
import {
  LEGACY_WORKSHOP_PROPOSALS_DIR as PROPOSALS_DIR,
  LEGACY_WORKSHOP_MAX_RECORD_BYTES as MAX_RECORD_BYTES,
  LEGACY_WORKSHOP_PROPOSAL_ID_PATTERN as PROPOSAL_ID_PATTERN,
  readLegacyWorkshopJson,
  readWorkshopMigrationRecords,
} from "./doctor-skill-workshop-sources.js";

const WORKSHOP_DIR = "skill-workshop";
export const MANIFEST_PATH = `${WORKSHOP_DIR}/proposals.json`;
// Preserve incomplete proposal artifacts outside active discovery so Doctor
// does not retry an impossible import on every run.
const RECOVERY_DIR = `${WORKSHOP_DIR}/recovery`;
export const RECOVERY_PROPOSALS_DIR = `${RECOVERY_DIR}/proposals`;

type LegacyWorkshopMigrationInspection = {
  externalProposalCount: number;
  externalProposalCountsByAgent: Record<string, number>;
  externalProposalDetails?: string[];
  legacyBackupRootCount: number;
  preservedLegacyBackupRootCount: number;
  automationReferences?: WorkshopAutomationReference[];
};

export async function inspectLegacySkillWorkshopMigration(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyWorkshopMigrationInspection> {
  const env = params.env ?? process.env;
  const { records, appliedEvents } = await readWorkshopMigrationRecords(env, true);
  // Lint needs ownership counts, not adoption verification through writable recovery readers.
  const { external } = classifyWorkshopRelocation(records, params.config, env);
  const backups = await listPendingLegacyCollectionBackupRoots(params.config, env);
  const automationReferences = await inspectWorkshopAutomationReferences({
    config: params.config,
    env,
    records,
    appliedEvents,
  });
  return {
    externalProposalCount: external.length,
    externalProposalCountsByAgent: external.reduce<Record<string, number>>((counts, plan) => {
      const ownerAgentId = plan.ownerAgentId ?? plan.unconfiguredOwnerAgentId ?? "unknown";
      counts[ownerAgentId] = (counts[ownerAgentId] ?? 0) + 1;
      return counts;
    }, {}),
    ...(external.length > 0
      ? {
          externalProposalDetails: external
            .toSorted((left, right) => left.record.id.localeCompare(right.record.id))
            .slice(0, 20)
            .map(({ record, ownerAgentId, unconfiguredOwnerAgentId }) =>
              truncateWithMarker(
                `${record.id}: ${record.target.skillDir} (owner: ${ownerAgentId ?? unconfiguredOwnerAgentId ?? "unknown"})`,
                2000,
                { marker: "…", reserve: 1, trimEnd: true },
              ),
            ),
        }
      : {}),
    legacyBackupRootCount: backups.length,
    preservedLegacyBackupRootCount: backups.filter((backup) => "warning" in backup).length,
    ...(automationReferences.length > 0 ? { automationReferences } : {}),
  };
}

/** Inventory migration-owned files without opening Workshop's writable recovery readers. */
export async function collectDoctorSkillWorkshopBackupResources(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const { records } = await readWorkshopMigrationRecords(env);
  const resources = new Map<string, "file" | "directory">();
  if (await pathExists(path.join(stateDir, MANIFEST_PATH))) {
    resources.set(path.join(stateDir, MANIFEST_PATH), "file");
  }
  if (await pathExists(path.join(stateDir, PROPOSALS_DIR))) {
    resources.set(path.join(stateDir, PROPOSALS_DIR), "directory");
    resources.set(path.join(stateDir, RECOVERY_PROPOSALS_DIR), "directory");
    const stateRoot = await root(stateDir);
    for (const entry of await stateRoot.list(PROPOSALS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory || !PROPOSAL_ID_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        const record = validateSkillProposalRecord(
          await readLegacyWorkshopJson(
            stateRoot,
            `${PROPOSALS_DIR}/${entry.name}/proposal.json`,
            MAX_RECORD_BYTES,
          ),
        );
        if (record.ok && record.value.id === entry.name) {
          records.push({ record: record.value, ownerAgentId: null });
        }
      } catch {
        // Invalid bundles can only be quarantined within the captured proposal roots.
      }
    }
  }
  const { external } = classifyWorkshopRelocation(records, params.config, env);
  for (const candidate of external) {
    if (!candidate.workspaceDir || !candidate.ownerAgentId) {
      continue;
    }
    resources.set(candidate.source, "directory");
    resources.set(
      resolveSkillProposalTarget({
        skillName: candidate.record.target.skillKey,
        config: params.config,
        agentId: candidate.ownerAgentId,
        env,
      }).skillDir,
      "directory",
    );
  }
  for (const backupRoot of await listPendingLegacyCollectionBackupRoots(params.config, env)) {
    if (!("destinationRoot" in backupRoot)) {
      continue;
    }
    for (const backup of backupRoot.backups) {
      resources.set(backup.backupDir, "directory");
      resources.set(path.join(backupRoot.destinationRoot, backup.manifest.id), "directory");
    }
  }
  return [...resources]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([pathname, kind]) => ({ path: pathname, kind }));
}
