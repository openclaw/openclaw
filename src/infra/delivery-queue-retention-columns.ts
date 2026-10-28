import { readJsonObjectMembers } from "./json-object-members.js";

type DeliveryQueueRetentionColumns = {
  retention_id_prefix: string | null;
  retention_max_age_ms: number | null;
  retention_max_entries: number | null;
};

/** Match the historical SQLite policy predicate, including its scalar coercions. */
export function deriveDeliveryQueueRetentionColumns(
  id: string,
  entryJson: string,
): DeliveryQueueRetentionColumns {
  const absent: DeliveryQueueRetentionColumns = {
    retention_id_prefix: null,
    retention_max_age_ms: null,
    retention_max_entries: null,
  };
  try {
    const policy = readJsonObjectMembers(entryJson).get("completionRetention");
    if (!policy?.startsWith("{")) {
      return absent;
    }
    const fields = readJsonObjectMembers(policy);
    const prefixJson = fields.get("idPrefix");
    const parsedPrefix: unknown = prefixJson?.startsWith('"')
      ? JSON.parse(prefixJson)
      : prefixJson?.startsWith("[") || prefixJson?.startsWith("{")
        ? prefixJson
        : undefined;
    const prefix = typeof parsedPrefix === "string" ? parsedPrefix : undefined;
    const integer = (raw: string | undefined): number | undefined => {
      // json_extract(true) is INTEGER 1, but JSON 1.0 and 1e0 are REAL.
      const value = raw === "true" ? 1 : raw && /^-?\d+$/u.test(raw) ? Number(raw) : Number.NaN;
      return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
    };
    const age = integer(fields.get("maxAgeMs"));
    const count = integer(fields.get("maxEntries"));
    return prefix &&
      !prefix.includes("\0") &&
      id.startsWith(prefix) &&
      age !== undefined &&
      count !== undefined
      ? {
          retention_id_prefix: prefix,
          retention_max_age_ms: age,
          retention_max_entries: count,
        }
      : absent;
  } catch {
    return absent;
  }
}
