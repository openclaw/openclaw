import type { Skill } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";
import { resolveSkillTrustInfo, type SkillSourceKind } from "./trust.js";

export type SkillIndexEntry = {
  id: string;
  name: string;
  description: string;
  path: string;
  baseDir: string;
  sourceLabel: string;
  sourceKind: SkillSourceKind;
  owner: string;
  writable: boolean;
  writableReason: string;
  entry: SkillEntry;
};

export type SkillIndex = {
  cacheKey: string;
  builtAt: number;
  entries: SkillIndexEntry[];
  byId: ReadonlyMap<string, SkillIndexEntry>;
  byName: ReadonlyMap<string, SkillIndexEntry[]>;
  byPath: ReadonlyMap<string, SkillIndexEntry>;
};

export function createSkillId(params: {
  sourceKind: SkillSourceKind;
  sourceLabel: string;
  name: string;
  path: string;
}): string {
  return `${params.sourceKind}:${params.sourceLabel}:${params.name}:${params.path}`;
}

export function buildSkillIndex(params: {
  cacheKey: string;
  entries: SkillEntry[];
  builtAt?: number;
}): SkillIndex {
  const indexed = params.entries.map((entry) => {
    const trust = resolveSkillTrustInfo(entry);
    return {
      id: createSkillId({
        sourceKind: trust.sourceKind,
        sourceLabel: trust.sourceLabel,
        name: entry.skill.name,
        path: entry.skill.filePath,
      }),
      name: entry.skill.name,
      description: entry.skill.description,
      path: entry.skill.filePath,
      baseDir: entry.skill.baseDir,
      sourceLabel: trust.sourceLabel,
      sourceKind: trust.sourceKind,
      owner: trust.owner,
      writable: trust.writable,
      writableReason: trust.writableReason,
      entry,
    } satisfies SkillIndexEntry;
  });

  const byId = new Map<string, SkillIndexEntry>();
  const byName = new Map<string, SkillIndexEntry[]>();
  const byPath = new Map<string, SkillIndexEntry>();
  for (const item of indexed) {
    byId.set(item.id, item);
    byPath.set(item.path, item);
    const named = byName.get(item.name);
    if (named) {
      named.push(item);
    } else {
      byName.set(item.name, [item]);
    }
  }

  return {
    cacheKey: params.cacheKey,
    builtAt: params.builtAt ?? Date.now(),
    entries: indexed,
    byId,
    byName,
    byPath,
  };
}

export function skillIndexEntries(index: SkillIndex): SkillEntry[] {
  return index.entries.map((entry) => entry.entry);
}

export function skillIndexResolvedSkills(index: SkillIndex): Skill[] {
  return index.entries.map((entry) => entry.entry.skill);
}
