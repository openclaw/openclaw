// Shared record helpers for legacy config migration modules.
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";
import { isRecord } from "../../../utils.js";
type JsonRecord = Record<string, unknown>;

export type { JsonRecord };
export { isRecord };

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

/** Clone a record-like config section, treating undefined as an empty object. */
export function cloneRecord<T extends JsonRecord>(value: T | undefined): T {
  return { ...value } as T;
}

/** Own-property guard used by migrations that must preserve falsy values. */
export function hasOwnKey(target: JsonRecord, key: string): boolean {
  return Object.hasOwn(target, key);
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
