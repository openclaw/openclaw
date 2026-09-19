import { canonicalizePath } from "../../agents/utils/paths.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Skill } from "./skill-contract.js";
import { compactSkillPath } from "./skill-paths.js";

export type SkillCollision = { winner: Skill; loser: Skill };
const skillsLogger = createSubsystemLogger("skills");
const reportedSkillCollisions = new Set<string>();

// Content includes declared frontmatter. Paths identify copies, not new conflicts.
export function warnSkillPrecedenceCollisions(collisions: SkillCollision[]): void {
  for (const { winner, loser } of collisions) {
    if (
      winner.contentHash &&
      winner.contentHash === loser.contentHash &&
      winner.name === loser.name &&
      winner.description === loser.description &&
      winner.disableModelInvocation === loser.disableModelInvocation
    ) {
      continue;
    }
    const fingerprint = sha256Hex(
      JSON.stringify(
        [winner, loser].map((skill) => [
          skill.name,
          skill.contentHash ?? skill.filePath,
          skill.description,
          skill.disableModelInvocation,
        ]),
      ),
    );
    if (reportedSkillCollisions.has(fingerprint)) {
      continue;
    }
    reportedSkillCollisions.add(fingerprint);
    warnSkillPrecedenceCollision(winner, loser);
  }
}

function warnSkillPrecedenceCollision(winner: Skill, loser: Skill): void {
  const collisionName = winner.name.slice(0, 128);
  skillsLogger.warn("Skill precedence collision resolved.", {
    skill: collisionName,
    winnerSource: winner.source,
    loserSource: loser.source,
    winnerPath: winner.filePath,
    loserPath: loser.filePath,
    consoleMessage:
      `Skill precedence collision: skill="${collisionName}" ` +
      `winner=${winner.source}:${compactSkillPath(winner.filePath)} ` +
      `loser=${loser.source}:${compactSkillPath(loser.filePath)}`,
  });
}

export function mergeSkillRecords<T extends { skill: Skill }>(
  records: T[],
  collisions?: SkillCollision[],
): T[] {
  const discoveredCollisions = collisions ?? [];
  const merged = new Map<string, T>();
  for (const record of records) {
    const replaced = merged.get(record.skill.name);
    if (
      replaced &&
      canonicalizePath(record.skill.filePath) !== canonicalizePath(replaced.skill.filePath)
    ) {
      discoveredCollisions.push({ winner: record.skill, loser: replaced.skill });
    }
    merged.set(record.skill.name, record);
  }
  if (!collisions) {
    warnSkillPrecedenceCollisions(discoveredCollisions);
  }
  return [...merged.values()].toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"));
}
