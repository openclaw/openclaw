import type { SnapshotValue } from "../../lib/snapshot-json.ts";
import type { detailsSnapshotSchema } from "./session-details-snapshot-schema.ts";

export type ChatDetailsSnapshot = NonNullable<SnapshotValue<typeof detailsSnapshotSchema>>;
export type DetailsSubagents = NonNullable<ChatDetailsSnapshot["subagents"]>;
export type DetailsSubagent = DetailsSubagents["rows"][number];
export type DetailsAutomation = NonNullable<ChatDetailsSnapshot["automations"]>["rows"][number];
export type DetailsSnapshotPatch = Partial<Omit<ChatDetailsSnapshot, "locale">>;

export function isDetailsSubagentWorking(row: Pick<DetailsSubagent, "status">) {
  return row.status === "running" || row.status === "waiting";
}

export function projectDetailsSubagents(rows: readonly DetailsSubagent[], mobile = false) {
  return {
    total: rows.length,
    rows: [
      ...rows.filter(isDetailsSubagentWorking),
      ...rows.filter((row) => !isDetailsSubagentWorking(row)),
    ]
      .slice(0, rows.length > (mobile ? 3 : 5) ? 4 : 5)
      .map(({ key, label, status }) => ({ key, label, status })),
    counts: (["running", "waiting", "queued", "done", "stopped"] as const)
      .map((status) => ({
        status,
        count: rows.filter((row) => (row.status === "failed" ? "done" : row.status) === status)
          .length,
      }))
      .filter((entry) => entry.count > 0),
  };
}
