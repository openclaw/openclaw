// Shared record helpers for legacy config migration modules.
import { isPlainObject } from "../../../infra/plain-object.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { isRecord } from "../../../utils.js";
type JsonRecord = Record<string, unknown>;

export type { JsonRecord };
export { isRecord };

export function someAgentEntry(
  value: unknown,
  predicate: (agent: Record<string, unknown>) => boolean,
): boolean {
  let matched = false;
  visitAgentEntries({ agents: value }, (agent) => {
    matched ||= predicate(agent);
  });
  return matched;
}

/** Visit mutable agent entries before or after read-time roster normalization. */
export function visitAgentEntries(
  raw: JsonRecord,
  visitor: (entry: JsonRecord, path: string) => void,
): void {
  const agents = isRecord(raw.agents) ? raw.agents : undefined;
  if (isRecord(agents?.entries)) {
    for (const [agentId, entry] of Object.entries(agents.entries)) {
      if (!isBlockedObjectKey(agentId) && isRecord(entry)) {
        visitor(entry, `agents.entries.${agentId}`);
      }
    }
    // Roster conversion discards a residual list; its settings must not affect other owners.
    return;
  }
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((entry, index) => {
      if (isRecord(entry) && !(typeof entry.id === "string" && isBlockedObjectKey(entry.id))) {
        visitor(entry, `agents.list[${index}]`);
      }
    });
  }
}

/** Visit agent defaults and authored entries without copying their mutable fields. */
export function visitAgentConfigScopes(
  raw: JsonRecord,
  visitor: (scope: JsonRecord, path: string) => void,
): void {
  const agents = isRecord(raw.agents) ? raw.agents : undefined;
  if (isRecord(agents?.defaults)) {
    visitor(agents.defaults, "agents.defaults");
  }
  visitAgentEntries(raw, visitor);
}

// Structured-clone equivalent for JSON-shaped config trees. The built-in
// structuredClone overflows the call stack on the deep documents the include
// resolver accepts, so containers are copied through an explicit work stack
// instead of recursion. Migration probes only read and rewrite plain-object
// config paths, so sharing non-JSON leaves by reference is fine, and blocked
// prototype keys stay filtered like the rest of the migration family.
export function deepCloneForMigrationProbe<T>(value: T): T {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return value;
  }
  const root: JsonRecord | unknown[] = Array.isArray(value) ? [] : {};
  const stack: Array<{ source: JsonRecord; target: JsonRecord | unknown[] }> = [
    // SAFETY: only containers pass the guard above, and arrays walk as records with numeric keys.
    { source: value as JsonRecord, target: root },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const [key, entry] of Object.entries(frame.source)) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      const childIsArray = Array.isArray(entry);
      const childIsObject = !childIsArray && isPlainObject(entry);
      // SAFETY: entry comes from a JsonRecord, so non-container children keep
      // their JSON leaf value and containers are recreated below.
      const child = childIsObject ? {} : childIsArray ? [] : entry;
      if (Array.isArray(frame.target)) {
        frame.target[Number(key)] = child;
      } else {
        frame.target[key] = child;
      }
      if (childIsObject || childIsArray) {
        // SAFETY: containers enqueue JSON children; arrays walk as numeric-key records.
        stack.push({ source: entry as JsonRecord, target: child as JsonRecord | unknown[] });
      }
    }
  }
  // SAFETY: containers are recreated structurally, so the clone keeps the probe's input type.
  return root as T;
}

/** Delete a nested retired config path, with `*` matching record entries. */
export function deleteRetiredPath(
  owner: unknown,
  path: readonly string[],
  removed?: string[],
  prefix = "",
): boolean {
  const [key, ...rest] = path;
  if (!isRecord(owner) || !key) {
    return false;
  }
  if (key === "*") {
    let changed = false;
    for (const [entry, value] of Object.entries(owner)) {
      changed = deleteRetiredPath(value, rest, removed, `${prefix}${entry}.`) || changed;
    }
    return changed;
  }
  if (rest.length === 0) {
    if (!Object.hasOwn(owner, key)) {
      return false;
    }
    delete owner[key];
    removed?.push(`${prefix}${key}`);
    return true;
  }
  const child = owner[key];
  if (!isRecord(child) || !deleteRetiredPath(child, rest, removed, `${prefix}${key}.`)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete owner[key];
  }
  return true;
}

/** Visit a channel root followed by its object-shaped accounts in config order. */
export function visitChannelEntries(
  raw: JsonRecord,
  channelId: string,
  visitor: (entry: JsonRecord, path: string) => void,
): void {
  const channels = raw.channels;
  if (!isRecord(channels)) {
    return;
  }
  const channel = channels[channelId];
  if (!isRecord(channel)) {
    return;
  }
  visitor(channel, `channels.${channelId}`);
  if (!isRecord(channel.accounts)) {
    return;
  }
  for (const [accountId, account] of Object.entries(channel.accounts)) {
    if (isRecord(account)) {
      visitor(account, `channels.${channelId}.accounts.${accountId}`);
    }
  }
}

export function moveLegacyConfigKey(
  owner: JsonRecord | null | undefined,
  legacyKey: string,
  canonicalKey: string,
  path: string,
  changes: string[],
): void {
  if (!owner || !Object.hasOwn(owner, legacyKey)) {
    return;
  }
  if (owner[canonicalKey] === undefined) {
    owner[canonicalKey] = owner[legacyKey];
    changes.push(`Moved ${path}.${legacyKey} → ${path}.${canonicalKey}.`);
  } else {
    changes.push(`Removed ${path}.${legacyKey} (${path}.${canonicalKey} already set).`);
  }
  delete owner[legacyKey];
}
