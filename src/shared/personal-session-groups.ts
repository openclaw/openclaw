import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { USER_PREFS_VALUE_BYTES } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";

/** Personal references only: membership never grants access or changes session metadata. */
export type PersonalSessionGroup = {
  id: string;
  label: string;
  sessionKeys: string[];
};

export const PERSONAL_SESSION_GROUP_LIMITS = {
  groups: 100,
  label: 80,
  id: 128,
  sessionKeys: 500,
  sessionKey: 512,
} as const;
const encoder = new TextEncoder();

/** The browser mirror and profile sync share the generic preference value-size limit. */
export function normalizePersonalSessionGroups(value: unknown): PersonalSessionGroup[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const groups: PersonalSessionGroup[] = [];
  const ids = new Set<string>();
  let bytes = 2; // JSON array brackets.
  for (const candidate of value.slice(0, PERSONAL_SESSION_GROUP_LIMITS.groups)) {
    const entry = asOptionalRecord(candidate);
    const id = normalizeOptionalString(entry?.id);
    const label = normalizeOptionalString(entry?.label)?.slice(
      0,
      PERSONAL_SESSION_GROUP_LIMITS.label,
    );
    if (!id || id.length > PERSONAL_SESSION_GROUP_LIMITS.id || !label || ids.has(id)) {
      continue;
    }
    const group: PersonalSessionGroup = { id, label, sessionKeys: [] };
    const groupBytes = encoder.encode(JSON.stringify(group)).length + (groups.length ? 1 : 0);
    if (bytes + groupBytes > USER_PREFS_VALUE_BYTES) {
      break;
    }
    bytes += groupBytes;
    const keys = new Set<string>();
    if (Array.isArray(entry?.sessionKeys)) {
      for (const candidateKey of entry.sessionKeys.slice(
        0,
        PERSONAL_SESSION_GROUP_LIMITS.sessionKeys,
      )) {
        const key = normalizeOptionalString(candidateKey);
        if (!key || key.length > PERSONAL_SESSION_GROUP_LIMITS.sessionKey || keys.has(key)) {
          continue;
        }
        const keyBytes = encoder.encode(JSON.stringify(key)).length + (keys.size ? 1 : 0);
        if (bytes + keyBytes > USER_PREFS_VALUE_BYTES) {
          break;
        }
        bytes += keyBytes;
        keys.add(key);
      }
    }
    group.sessionKeys = [...keys];
    ids.add(id);
    groups.push(group);
  }
  return groups;
}
