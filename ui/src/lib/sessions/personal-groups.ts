import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { USER_PREFS_VALUE_BYTES } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.ts";

/** Personal references only: membership never grants access or changes session metadata. */
export type PersonalSessionGroup = {
  id: string;
  label: string;
  sessionKeys: string[];
};

const MAX_GROUPS = 100;
const MAX_LABEL_LENGTH = 80;
const MAX_ID_LENGTH = 128;
const MAX_SESSION_KEYS = 500;
const MAX_SESSION_KEY_LENGTH = 512;
const encoder = new TextEncoder();

/** The browser mirror and profile sync share the generic preference value-size limit. */
export function normalizePersonalSessionGroups(value: unknown): PersonalSessionGroup[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const groups: PersonalSessionGroup[] = [];
  const ids = new Set<string>();
  let bytes = 2; // JSON array brackets.
  for (const candidate of value.slice(0, MAX_GROUPS)) {
    const entry = asOptionalRecord(candidate);
    const id = normalizeOptionalString(entry?.id);
    const label = normalizeOptionalString(entry?.label)?.slice(0, MAX_LABEL_LENGTH);
    if (!id || id.length > MAX_ID_LENGTH || !label || ids.has(id)) {
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
      for (const candidateKey of entry.sessionKeys.slice(0, MAX_SESSION_KEYS)) {
        const key = normalizeOptionalString(candidateKey);
        if (!key || key.length > MAX_SESSION_KEY_LENGTH || keys.has(key)) {
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
