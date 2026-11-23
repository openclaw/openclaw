import path from "node:path";
import type { Skill } from "../loading/skill-contract.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import type { SkillSnapshot } from "../types.js";
import { resolveSkillReadPath } from "../workspace-skill-read-path.js";

// Published snapshots are immutable; harness handoff also clones and freezes them.
// Keep derived facts outside that plain-data contract, scoped to the exact snapshot.
const skillReadIndexes = new WeakMap<SkillSnapshot, ReadonlyMap<string, Skill>>();

export function prepareSkillReadIndex(snapshot: SkillSnapshot): ReadonlyMap<string, Skill> {
  const existing = skillReadIndexes.get(snapshot);
  if (existing) {
    return existing;
  }
  const index = new Map<string, Skill>();
  for (const skill of snapshot.resolvedSkills ?? []) {
    if (!skill.name.trim()) {
      continue;
    }
    const filePath = skill.filePath.trim();
    const baseDir = skill.baseDir.trim();
    if (filePath) {
      index.set(resolveSkillReadPath(skill), skill);
    }
    if (resolveSkillFileHost(skill) === "workspace") {
      continue;
    }
    if (filePath.startsWith("node://")) {
      index.set(filePath, skill);
    } else if (path.isAbsolute(filePath)) {
      index.set(path.resolve(filePath), skill);
    }
    if (path.isAbsolute(baseDir)) {
      index.set(path.resolve(baseDir, "SKILL.md"), skill);
    }
  }
  skillReadIndexes.set(snapshot, index);
  return index;
}
