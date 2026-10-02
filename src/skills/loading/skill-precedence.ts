import { canonicalizePath } from "../../agents/utils/paths.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Skill } from "./skill-contract.js";
import { compactSkillPath } from "./skill-paths.js";

export type SkillCollision = { winner: Skill; loser: Skill };
const skillsLogger = createSubsystemLogger("skills");
const reportedSkillCollisions = new Map<string, string>();
const reportedGroupsBySource = new Map<string, Set<string>>();

// Source refresh supplies current hashes; retain only the last aggregate digest per root pair.
export function reportSkillPrecedenceCollisions(
  collisions: SkillCollision[],
  sourceKey: string,
): void {
  const groups = new Map<
    string,
    SkillCollision & {
      winnerRoot: string;
      loserRoot: string;
      names: Set<string>;
      contents: Set<string>;
    }
  >();
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
    const winnerRoot = winner.discoveryRoot?.path ?? winner.baseDir;
    const loserRoot = loser.discoveryRoot?.path ?? loser.baseDir;
    const key = JSON.stringify([winnerRoot, loserRoot, winner.source, loser.source]);
    const group = groups.get(key) ?? {
      winner,
      loser,
      winnerRoot,
      loserRoot,
      names: new Set<string>(),
      contents: new Set<string>(),
    };
    group.names.add(winner.name);
    group.contents.add(
      JSON.stringify(
        [winner, loser].map((skill) => [
          skill.name,
          skill.contentHash ?? skill.filePath,
          skill.description,
          skill.disableModelInvocation,
          skill.discoveryRoot?.worktree,
        ]),
      ),
    );
    groups.set(key, group);
  }
  for (const key of reportedGroupsBySource.get(sourceKey) ?? []) {
    if (!groups.has(key)) {
      reportedSkillCollisions.delete(key);
    }
  }
  if (groups.size > 0) {
    reportedGroupsBySource.set(sourceKey, new Set(groups.keys()));
  } else {
    reportedGroupsBySource.delete(sourceKey);
  }
  for (const [key, group] of groups) {
    const digest = sha256Hex(JSON.stringify([...group.contents].toSorted()));
    if (reportedSkillCollisions.get(key) === digest) {
      continue;
    }
    reportedSkillCollisions.set(key, digest);
    const names = [...group.names].toSorted();
    const sample = names.slice(0, 3).map((name) => name.slice(0, 128));
    if (names.length > sample.length) {
      sample.push(`+${names.length - sample.length} more`);
    }
    const { winner, loser, winnerRoot, loserRoot } = group;
    const isWorkspaceSource = (source: string) =>
      source === "openclaw-workspace" || source === "agents-skills-project";
    const lowerTrust =
      (isWorkspaceSource(winner.source) &&
        (loser.source === "openclaw-bundled" || loser.source === "openclaw-custodian")) ||
      (winner.discoveryRoot?.worktree &&
        !loser.discoveryRoot?.worktree &&
        isWorkspaceSource(loser.source));
    skillsLogger[lowerTrust ? "warn" : "info"]("Skill precedence collisions resolved.", {
      winnerSource: winner.source,
      loserSource: loser.source,
      winnerRoot,
      loserRoot,
      skillCount: names.length,
      skills: sample,
      consoleMessage:
        `${compactSkillPath(winnerRoot)} shadows ${names.length} skills from ` +
        `${compactSkillPath(loserRoot)} (${sample.join(", ")})`,
    });
  }
}

export function mergeSkillRecords<T extends { skill: Skill }>(
  records: T[],
  sourceKey: string,
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
    reportSkillPrecedenceCollisions(discoveredCollisions, sourceKey);
  }
  return [...merged.values()].toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"));
}

/** Append lower-precedence names without changing the order of either tier. */
export function appendLowerPrecedenceSkillRecords<T extends { skill: Skill }>(
  entries: T[],
  lower: readonly T[],
  onCollision: (winner: T, loser: T) => void,
): T[] {
  if (lower.length === 0) {
    return entries;
  }
  const winners = new Map(entries.map((entry) => [entry.skill.name, entry]));
  for (const entry of lower) {
    const winner = winners.get(entry.skill.name);
    if (winner) {
      onCollision(winner, entry);
    } else {
      winners.set(entry.skill.name, entry);
      entries.push(entry);
    }
  }
  return entries;
}
