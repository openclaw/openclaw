// Helpers for session preferences that should survive session id rollovers.
import type { SessionEntry, SessionPersistentPreferenceField } from "./types.js";

export const SESSION_PERSISTENT_PREFERENCE_FIELDS = [
  "responseUsage",
  "thinkingLevel",
  "modelOverride",
] as const satisfies readonly SessionPersistentPreferenceField[];

const SESSION_PERSISTENT_PREFERENCE_FIELD_SET = new Set<string>(
  SESSION_PERSISTENT_PREFERENCE_FIELDS,
);

export function normalizePersistentPreferenceFields(
  value: unknown,
): SessionPersistentPreferenceField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields = value.filter((field): field is SessionPersistentPreferenceField => {
    return typeof field === "string" && SESSION_PERSISTENT_PREFERENCE_FIELD_SET.has(field);
  });
  return fields.length > 0 ? [...new Set(fields)] : undefined;
}

export function hasPersistentPreferenceField(
  entry: SessionEntry | undefined,
  field: SessionPersistentPreferenceField,
): boolean {
  return Boolean(entry?.persistentPreferenceFields?.includes(field));
}

export function setPersistentPreferenceField(
  entry: SessionEntry,
  field: SessionPersistentPreferenceField,
): boolean {
  const fields = normalizePersistentPreferenceFields(entry.persistentPreferenceFields) ?? [];
  if (fields.includes(field)) {
    if (fields !== entry.persistentPreferenceFields) {
      entry.persistentPreferenceFields = fields;
      return true;
    }
    return false;
  }
  entry.persistentPreferenceFields = [...fields, field];
  return true;
}

export function clearPersistentPreferenceField(
  entry: SessionEntry,
  field: SessionPersistentPreferenceField,
): boolean {
  const fields = normalizePersistentPreferenceFields(entry.persistentPreferenceFields);
  if (!fields?.includes(field)) {
    return false;
  }
  const next = fields.filter((candidate) => candidate !== field);
  if (next.length > 0) {
    entry.persistentPreferenceFields = next;
  } else {
    delete entry.persistentPreferenceFields;
  }
  return true;
}
