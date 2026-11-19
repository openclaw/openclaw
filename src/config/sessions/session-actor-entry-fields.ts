import { internSessionEntryField } from "./session-skill-snapshot-intern.js";
import type { SessionEntry } from "./types.js";

const reportFields = ["systemPrompt", "injectedWorkspaceFiles", "skills", "tools"] as const;
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

export function sessionActorEntryFields(entry: SessionEntry | undefined): object[] {
  const fields: object[] = entry?.skillsSnapshot ? [entry.skillsSnapshot] : [];
  for (const field of reportFields) {
    const value = entry?.systemPromptReport?.[field];
    if (value) {
      fields.push(value);
    }
  }
  return fields;
}
