import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import type { PackageDirInstallTransaction } from "../../infra/install-package-dir.js";
import { resolveClawHubSkillStatusLinkSync } from "./clawhub-status.js";
import {
  readClawHubSkillsLockfile,
  replaceClawHubSkillLockEntryExpected,
} from "./clawhub-store.js";
import { planClawHubSkillUninstall } from "./clawhub-uninstall.js";
import type { ClawHubSkillLockEntry } from "./workspace-types.js";

export async function rollbackDeferredSkillInstall(params: {
  workspaceDir: string;
  slug: string;
  version: string;
  integrity: string;
  previous: ClawHubSkillLockEntry;
  installed?: ClawHubSkillLockEntry;
  transaction: PackageDirInstallTransaction;
  verifyInstalled: boolean;
}): Promise<void> {
  const current = (await readClawHubSkillsLockfile(params.workspaceDir)).skills[params.slug];
  const hasInstalledEntry =
    params.installed && stableStringify(current) === stableStringify(params.installed);
  if (!hasInstalledEntry && stableStringify(current) !== stableStringify(params.previous)) {
    throw new Error(`Skill ${JSON.stringify(params.slug)} tracking changed during rollback.`);
  }
  if (params.verifyInstalled) {
    if (!hasInstalledEntry) {
      throw new Error(`Skill ${JSON.stringify(params.slug)} tracking changed during rollback.`);
    }
    const targetDir = path.join(params.workspaceDir, "skills", params.slug);
    const link = resolveClawHubSkillStatusLinkSync({
      workspaceDir: params.workspaceDir,
      skillDir: targetDir,
      skillKey: params.slug,
    });
    const planned = await planClawHubSkillUninstall({
      workspaceDir: params.workspaceDir,
      slug: params.slug,
      expectedVersion: params.version,
    });
    if (!link?.valid || link.artifact?.integrity !== params.integrity || !planned.ok) {
      throw new Error(`Skill ${JSON.stringify(params.slug)} changed after its Claw upgrade.`);
    }
  }
  await params.transaction.rollback();
  if (hasInstalledEntry && params.installed) {
    replaceClawHubSkillLockEntryExpected({
      workspaceDir: params.workspaceDir,
      slug: params.slug,
      expected: params.installed,
      replacement: params.previous,
    });
  }
}
