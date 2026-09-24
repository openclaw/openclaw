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
  const groups = new Map<string, SkillCollision & { roots: Set<string>; unreported: boolean }>();
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
          skill.source,
          skill.contentHash ?? skill.filePath,
          skill.description,
          skill.disableModelInvocation,
        ]),
      ),
    );
    const key = JSON.stringify([winner.name, winner.source, loser.source]);
    const group = groups.get(key) ?? { winner, loser, roots: new Set<string>(), unreported: false };
    group.winner = winner;
    group.roots.add(winner.baseDir).add(loser.baseDir);
    group.unreported ||= !reportedSkillCollisions.has(fingerprint);
    groups.set(key, group);
    reportedSkillCollisions.add(fingerprint);
  }
  for (const group of groups.values()) {
    if (group.unreported) {
      reportSkillPrecedenceCollision(group.winner, group.loser, group.roots.size);
    }
  }
}

function reportSkillPrecedenceCollision(winner: Skill, loser: Skill, affectedRoots: number): void {
  const collisionName = winner.name.slice(0, 128);
  const intentionalOverride =
    winner.source !== loser.source &&
    (winner.source === "openclaw-workspace" || winner.source === "agents-skills-project");
  skillsLogger[intentionalOverride ? "info" : "warn"]("Skill precedence collision resolved.", {
    skill: collisionName,
    winnerSource: winner.source,
    loserSource: loser.source,
    winnerPath: winner.filePath,
    loserPath: loser.filePath,
    affectedRoots,
    consoleMessage:
      `Skill precedence collision: skill="${collisionName}" ` +
      `winner=${winner.source}:${compactSkillPath(winner.filePath)} ` +
      `loser=${loser.source}:${compactSkillPath(loser.filePath)} affectedRoots=${affectedRoots}`,
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
