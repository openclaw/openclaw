import { internSessionEntryField, sessionEntryFieldKey } from "./session-skill-snapshot-intern.js";
import type { SessionEntry, SessionSystemPromptReport } from "./types.js";

const reportFields = ["systemPrompt", "injectedWorkspaceFiles", "skills", "tools"] as const;
type ReportField = (typeof reportFields)[number];
type Field = "skillsSnapshot" | ReportField;
export type SessionActorEntryWire = Omit<SessionEntry, "systemPromptReport"> & {
  systemPromptReport?: Partial<SessionSystemPromptReport>;
};
export type SessionActorEntryFieldReferences = Partial<Record<Field, string>>;

/** Only immutable, content-addressed subtrees; per-session report provenance stays inline. */
export function shareSessionActorEntryFields(
  entry: SessionEntry | undefined,
): SessionEntry | undefined {
  if (!entry) {
    return entry;
  }
  let shared = entry;
  const skills = entry.skillsSnapshot && internSessionEntryField(entry.skillsSnapshot);
  const originalReport = entry.systemPromptReport;
  let report = originalReport;
  if (report) {
    for (const field of reportFields) {
      const value = internSessionEntryField(report[field]);
      if (value !== report[field]) {
        if (report === originalReport && Object.isFrozen(originalReport)) {
          report = { ...originalReport };
        }
        Reflect.set(report, field, value);
      }
    }
  }
  if (skills !== entry.skillsSnapshot || report !== entry.systemPromptReport) {
    if (Object.isFrozen(entry)) {
      shared = { ...entry };
    }
    if (skills) {
      shared.skillsSnapshot = skills;
    }
    if (report) {
      shared.systemPromptReport = report;
    }
  }
  return shared;
}

export function sessionActorEntryFields(entry: SessionActorEntryWire | undefined): object[] {
  const fields: object[] = entry?.skillsSnapshot ? [entry.skillsSnapshot] : [];
  for (const field of reportFields) {
    const value = entry?.systemPromptReport?.[field];
    if (value) {
      fields.push(value);
    }
  }
  return fields;
}

export function projectSessionActorEntryFields(
  entry: SessionEntry | undefined,
  known: ReadonlySet<string>,
) {
  if (!entry) {
    return { entry };
  }
  const wire: SessionActorEntryWire = { ...entry };
  const entryFields: SessionActorEntryFieldReferences = {};
  if (entry.skillsSnapshot) {
    const key = sessionEntryFieldKey(entry.skillsSnapshot);
    if (known.has(key)) {
      entryFields.skillsSnapshot = key;
      wire.skillsSnapshot = undefined;
    }
  }
  if (entry.systemPromptReport) {
    const report = { ...entry.systemPromptReport };
    wire.systemPromptReport = report;
    for (const field of reportFields) {
      const key = sessionEntryFieldKey(report[field]);
      if (known.has(key)) {
        entryFields[field] = key;
        Reflect.set(report, field, undefined);
      }
    }
  }
  return { entry: wire, entryFields };
}

export function restoreSessionActorEntryFields(
  entry: SessionActorEntryWire | undefined,
  references: SessionActorEntryFieldReferences | undefined,
  pinned: ReadonlyMap<string, object>,
): void {
  for (const [field, key] of Object.entries(references ?? {})) {
    const value = pinned.get(key);
    if (!value) {
      throw new Error("Session actor entry field was not advertised");
    }
    Reflect.set(field === "skillsSnapshot" ? entry! : entry!.systemPromptReport!, field, value);
  }
}
