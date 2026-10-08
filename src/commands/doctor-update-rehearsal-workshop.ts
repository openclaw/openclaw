import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists, root } from "../infra/fs-safe.js";
import { resolveSkillProposalTarget } from "../skills/workshop/store.js";
import { listPendingLegacyCollectionBackupRoots } from "./doctor-skill-workshop-collection-backups.js";
import {
  classifyWorkshopRelocation,
  isReadOnlyRehearsalProposal,
} from "./doctor-skill-workshop-relocation.js";
import {
  LEGACY_WORKSHOP_PROPOSALS_DIR as PROPOSALS_DIR,
  readLegacyWorkshopProposals,
  readWorkshopMigrationRecords,
} from "./doctor-skill-workshop-sources.js";
const MANIFEST_PATH = "skill-workshop/proposals.json";
const RECOVERY_PROPOSALS_DIR = "skill-workshop/recovery/proposals";

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
    for (const proposal of await readLegacyWorkshopProposals(await root(stateDir))) {
      records.push(proposal);
    }
  }
  const { external } = classifyWorkshopRelocation(
    records.filter(({ record }) => !isReadOnlyRehearsalProposal(record, env)),
    params.config,
    env,
  );
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
