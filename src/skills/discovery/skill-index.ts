import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillSource } from "../loading/source.js";
import type { SkillEntry } from "../types.js";

export type SkillIndexEntry = {
  entry: SkillEntry;
  name: string;
  normalizedName: string;
  skillKey: string;
  normalizedSkillKey: string;
  source: string;
  bundled: boolean;
  agentAllowed: boolean;
  runtimeVisible: boolean;
  promptVisible: boolean;
  userInvocable: boolean;
};

export type SkillIndex = {
  entries: SkillIndexEntry[];
  runtimeEntries: SkillEntry[];
  promptVisibleEntries: SkillEntry[];
  userInvocableEntries: SkillEntry[];
  byName: ReadonlyMap<string, SkillIndexEntry>;
  byNormalizedName: ReadonlyMap<string, readonly SkillIndexEntry[]>;
};

export type BuildSkillIndexOptions = {
  bundledNames?: ReadonlySet<string>;
  agentSkillFilter?: readonly string[];
};

export function normalizeSkillIndexName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isSkillRuntimeVisible(entry: SkillEntry): boolean {
  return entry.exposure?.includeInRuntimeRegistry ?? true;
}

export function isSkillPromptVisible(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.includeInAvailableSkillsPrompt ?? true;
  }
  if (entry.invocation) {
    return !entry.invocation.disableModelInvocation;
  }
  return !entry.skill.disableModelInvocation;
}

export function isSkillUserInvocable(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.userInvocable ?? true;
  }
  if (entry.invocation) {
    return entry.invocation.userInvocable ?? true;
  }
  return true;
}

export function buildSkillIndex(
  entries: readonly SkillEntry[],
  opts?: BuildSkillIndexOptions,
): SkillIndex {
  const byName = new Map<string, SkillIndexEntry>();
  const normalized = new Map<string, SkillIndexEntry[]>();
  const indexedEntries: SkillIndexEntry[] = [];
  const runtimeEntries: SkillEntry[] = [];
  const promptVisibleEntries: SkillEntry[] = [];
  const userInvocableEntries: SkillEntry[] = [];

  for (const entry of entries) {
    const name = entry.skill.name;
    const skillKey = resolveSkillKey(entry.skill, entry);
    const source = resolveSkillSource(entry.skill);
    const indexed: SkillIndexEntry = {
      entry,
      name,
      normalizedName: normalizeSkillIndexName(name),
      skillKey,
      normalizedSkillKey: normalizeSkillIndexName(skillKey),
      source,
      bundled:
        source === "openclaw-bundled" ||
        (source === "unknown" && opts?.bundledNames?.has(name) === true),
      agentAllowed: opts?.agentSkillFilter === undefined || opts.agentSkillFilter.includes(name),
      runtimeVisible: isSkillRuntimeVisible(entry),
      promptVisible: isSkillPromptVisible(entry),
      userInvocable: isSkillUserInvocable(entry),
    };

    indexedEntries.push(indexed);
    byName.set(name, indexed);
    addNormalizedEntry(normalized, indexed.normalizedName, indexed);
    addNormalizedEntry(normalized, indexed.normalizedSkillKey, indexed);
    if (indexed.runtimeVisible) {
      runtimeEntries.push(entry);
    }
    if (indexed.promptVisible) {
      promptVisibleEntries.push(entry);
    }
    if (indexed.userInvocable) {
      userInvocableEntries.push(entry);
    }
  }

  return {
    entries: indexedEntries,
    runtimeEntries,
    promptVisibleEntries,
    userInvocableEntries,
    byName,
    byNormalizedName: normalized,
  };
}

function addNormalizedEntry(
  normalized: Map<string, SkillIndexEntry[]>,
  key: string,
  entry: SkillIndexEntry,
) {
  if (!key) {
    return;
  }
  const existing = normalized.get(key);
  if (existing) {
    if (!existing.includes(entry)) {
      existing.push(entry);
    }
    return;
  }
  normalized.set(key, [entry]);
}
