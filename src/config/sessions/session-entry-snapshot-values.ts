import type { SessionEntrySnapshotRow } from "./session-entry-storage.types.js";

export const sessionEntrySnapshotColumnsDefinition = [
  ["sessionDiffBaseline", "session_diff_baseline_json"],
  ["skillsSnapshot", "skills_snapshot_json"],
  ["systemPromptReport", "system_prompt_report_json"],
] as const;

export type SessionEntrySnapshotField = (typeof sessionEntrySnapshotColumnsDefinition)[number][0];
export type SessionEntryProjection = "full" | "list" | readonly SessionEntrySnapshotField[];

export function attachSessionEntrySnapshots<T extends object>(
  entry: T,
  row: SessionEntrySnapshotRow,
  projection: SessionEntryProjection = "full",
): T {
  for (const [field, alias] of sessionEntrySnapshotColumnsDefinition) {
    if (projection !== "full" && (projection === "list" || !projection.includes(field))) {
      // Pending legacy rows may still carry snapshots inline.
      Reflect.deleteProperty(entry, field);
      continue;
    }
    const valueJson = row[alias];
    if (valueJson != null) {
      const value: unknown = JSON.parse(valueJson);
      Object.assign(entry, { [field]: value });
    }
  }
  return entry;
}
