import path from "node:path";
import {
  readLocalSkillCardContentSync,
  resolveClawHubSkillStatusLinkSync,
  resolveLocalSkillCardStatusSync,
} from "../lifecycle/clawhub-status.js";
import { readClawHubSkillsLockfileStatusSync } from "../lifecycle/clawhub-store.js";
import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillSource } from "../loading/source.js";
import type { SkillEntry } from "../types.js";
import type { WorkspaceSkillStatusFacts } from "./status.types.js";

/** Read beside the skill files; Gateway configuration still determines eligibility. */
export function readWorkspaceSkillStatusFacts(params: {
  entries: readonly SkillEntry[];
  workspaceDir: string;
  managedSkillsDir: string;
  skillCardKey?: string;
}): WorkspaceSkillStatusFacts {
  const workspaceLock = readClawHubSkillsLockfileStatusSync(params.workspaceDir);
  const managedParent = path.dirname(path.resolve(params.managedSkillsDir));
  const managedLock =
    managedParent === path.resolve(params.workspaceDir)
      ? workspaceLock
      : readClawHubSkillsLockfileStatusSync(managedParent);
  return {
    workspaceDir: params.workspaceDir,
    managedSkillsDir: params.managedSkillsDir,
    files: params.entries.map((entry) => {
      const source = resolveSkillSource(entry.skill);
      const bundled = source === "openclaw-bundled" || source === "openclaw-custodian";
      const managed = source === "openclaw-managed";
      const skillKey = resolveSkillKey(entry.skill, entry);
      const clawhub =
        params.workspaceDir && !bundled
          ? resolveClawHubSkillStatusLinkSync({
              workspaceDir: managed ? managedParent : params.workspaceDir,
              skillDir: entry.skill.baseDir,
              skillKey,
              lockRead: managed ? managedLock : workspaceLock,
              lockfileScope: managed ? "managed" : "workspace",
            })
          : undefined;
      const card = resolveLocalSkillCardStatusSync(entry.skill.baseDir);
      const content =
        card && params.skillCardKey === skillKey
          ? readLocalSkillCardContentSync(entry.skill.baseDir)
          : undefined;
      return {
        name: entry.skill.name,
        filePath: entry.skill.filePath,
        ...(clawhub ? { clawhub } : {}),
        ...(card ? { skillCard: { ...card, ...(content !== undefined ? { content } : {}) } } : {}),
      };
    }),
  };
}
