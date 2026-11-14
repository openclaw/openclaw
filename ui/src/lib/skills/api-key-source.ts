import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigSnapshot } from "../../api/types.ts";
import { resolveEditableSnapshotConfig } from "../config/config-state-model.ts";
import { storedSecretSource, type StoredSecretSource } from "../config/stored-secret-source.ts";

/**
 * A skill API key's stored source: null when unset, undefined while the snapshot is unusable.
 * Saving over a SecretRef or ${VAR} would store the key as plaintext in openclaw.json. Only the
 * lazy skill dialog imports this, keeping the classifier out of the Skills route's first load.
 */
export function storedSkillApiKeySource(
  snapshot: ConfigSnapshot | null | undefined,
  skillKey: string,
): StoredSecretSource | null | undefined {
  const config = resolveEditableSnapshotConfig(snapshot);
  if (!config || snapshot?.valid === false) {
    return undefined;
  }
  const skills = config.skills;
  const entry = isRecord(skills) && isRecord(skills.entries) ? skills.entries[skillKey] : undefined;
  if (!isRecord(entry) || entry.apiKey === undefined) {
    return null;
  }
  return storedSecretSource(snapshot, ["skills", "entries", skillKey, "apiKey"]);
}

/** Whether Save may write a typed key: undefined until the stored source is known. */
export function skillApiKeyReplaceable(
  snapshot: ConfigSnapshot | null | undefined,
  skillKey: string,
): boolean | undefined {
  const source = storedSkillApiKeySource(snapshot, skillKey);
  return source === undefined ? undefined : source === null || source.kind === "literal";
}
