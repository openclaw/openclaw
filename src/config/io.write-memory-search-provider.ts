// Canonicalizes the memory-search provider slots that a config write explicitly sets.
//
// The config boundary normalizes provider casing in memory (see
// zod-schema.memory-search.ts), so the persisted file has to use that same canonical
// form: otherwise the file on disk and the resolved runtime config disagree. Only the
// slots this write explicitly sets are rewritten, so every value the write does not
// touch stays byte-identical and no whole-config rewrite can happen.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { containsEnvVarReference } from "./env-substitution.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";

const PROVIDER_SLOT = ["memory", "search", "provider"] as const;
const FALLBACK_SLOT = ["memory", "search", "fallback"] as const;
const SLOTS = [PROVIDER_SLOT, FALLBACK_SLOT] as const;

/** The scope a written path belongs to: the root config, or a single agent entry. */
type WriteScope =
  | { kind: "root"; rest: readonly string[] }
  | { kind: "agent"; agentId: string; rest: readonly string[] };

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/**
 * Resolves the owning scope of an explicit set path.
 *
 * Only the root scope and a single agent entry can own a memory-search slot. A write
 * that replaces a whole roster (`agents`, `agents.entries`, `agents.list`) can carry
 * values the author never touched, so those paths resolve to no scope.
 */
function resolveScope(path: readonly string[]): WriteScope | undefined {
  if (path.length === 0) {
    return undefined;
  }
  if (path[0] === "agents") {
    if (path[1] !== "entries" && path[1] !== "list") {
      return undefined;
    }
    if (path.length < 3) {
      return undefined;
    }
    const agentId = path[2];
    if (agentId === undefined) {
      return undefined;
    }
    if (path[1] === "list" && parseConfigPathArrayIndex(agentId) === undefined) {
      // A list roster addresses entries by id, not by index, in written paths.
      return undefined;
    }
    return { kind: "agent", agentId, rest: path.slice(3) };
  }
  return { kind: "root", rest: path };
}

/** True when `path` is the slot itself or one of its ancestors. */
function isPrefixOfSlot(path: readonly string[], slot: readonly string[]): boolean {
  if (path.length > slot.length) {
    return false;
  }
  return slot.slice(0, path.length).every((segment, index) => segment === path[index]);
}

function getAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecordValue(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setAt(root: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) {
    return value;
  }
  const [head, ...tail] = path;
  if (head === undefined) {
    return root;
  }
  if (Array.isArray(root)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= root.length) {
      return root;
    }
    const next = [...root];
    next[index] = setAt(next[index], tail, value);
    return next;
  }
  if (!isRecordValue(root)) {
    return root;
  }
  const next = { ...root };
  next[head] = setAt(next[head], tail, value);
  return next;
}

/**
 * Finds the agent entry a scope addresses, in either roster form.
 *
 * A keyed roster stores the entry under its id; a list roster stores it as an entry with
 * a matching `id`. The lookup is by id so both forms resolve to the same agent.
 */
function findAgentEntry(config: unknown, agentId: string): unknown {
  const agents = getAt(config, ["agents"]);
  if (!isRecordValue(agents)) {
    return undefined;
  }
  const entries = agents.entries;
  if (isRecordValue(entries)) {
    const entry = entries[agentId];
    if (entry !== undefined) {
      return entry;
    }
  }
  const list = agents.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (isRecordValue(entry) && entry.id === agentId) {
        return entry;
      }
    }
  }
  return undefined;
}

function setAgentEntry(config: unknown, agentId: string, entry: unknown): unknown {
  const agents = getAt(config, ["agents"]);
  if (!isRecordValue(agents)) {
    return config;
  }
  const entries = agents.entries;
  if (isRecordValue(entries) && Object.hasOwn(entries, agentId)) {
    return setAt(config, ["agents", "entries", agentId], entry);
  }
  const list = agents.list;
  if (Array.isArray(list)) {
    const index = list.findIndex(
      (candidate) => isRecordValue(candidate) && candidate.id === agentId,
    );
    if (index >= 0) {
      return setAt(config, ["agents", "list", String(index)], entry);
    }
  }
  return config;
}

/**
 * Rewrites the explicitly set memory-search provider slots to their canonical form.
 *
 * A slot is rewritten only when the write explicitly set it: the explicit value source
 * has to carry a provider id for that slot. Values the write merely carried over (for
 * example inside a replaced agent entry) stay byte-identical, and a value that resolves
 * from an environment template is left alone because the template is resolved and
 * normalized by the config boundary on load, not on write.
 */
export function canonicalizeExplicitMemorySearchProviderSlots(
  config: unknown,
  explicitSetPaths: readonly (readonly string[])[],
  explicitSetValueSource: unknown,
): unknown {
  if (!Array.isArray(explicitSetPaths) || explicitSetPaths.length === 0) {
    return config;
  }
  let next = config;
  for (const path of explicitSetPaths) {
    const scope = resolveScope(path);
    if (!scope) {
      continue;
    }
    for (const slot of SLOTS) {
      if (!isPrefixOfSlot(scope.rest, slot)) {
        continue;
      }
      // The explicit value source proves the author set this slot in this write.
      const authoredScopeRoot =
        scope.kind === "root" ? explicitSetValueSource : findAgentEntry(explicitSetValueSource, scope.agentId);
      if (authoredScopeRoot === undefined) {
        continue;
      }
      const authored = getAt(authoredScopeRoot, slot);
      if (typeof authored !== "string") {
        continue;
      }
      if (containsEnvVarReference(authored)) {
        // The template is resolved and normalized on load; rewriting it here would
        // change the referenced variable name.
        continue;
      }
      const canonical = normalizeOptionalLowercaseString(authored);
      if (canonical === undefined) {
        // A blank id stays as authored: the schema resolves it to "unset" on load, and
        // removing a key belongs to the unset path, not to this normalization.
        continue;
      }
      const scopeRoot =
        scope.kind === "root" ? next : findAgentEntry(next, scope.agentId);
      if (scopeRoot === undefined) {
        continue;
      }
      const current = getAt(scopeRoot, slot);
      if (typeof current !== "string" || current === canonical) {
        continue;
      }
      const updatedScopeRoot = setAt(scopeRoot, slot, canonical);
      next =
        scope.kind === "root" ? updatedScopeRoot : setAgentEntry(next, scope.agentId, updatedScopeRoot);
    }
  }
  return next;
}
