import { note } from "../../packages/terminal-core/src/note.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { recordDoctorRepairOutcome } from "../infra/update-doctor-result.js";

export function noteDoctorMigrationResult(
  result: Partial<Pick<MigrationMessages, "changes" | "notices" | "warnings">>,
  { prefix = "", changesTitle = "Doctor changes" }: { prefix?: string; changesTitle?: string } = {},
): void {
  recordDoctorRepairOutcome(result.warnings?.length ? undefined : Boolean(result.changes?.length));
  for (const key of ["changes", "notices", "warnings"] as const) {
    const entries = result[key];
    if (entries?.length) {
      note(
        entries.map((entry) => `${prefix}${entry}`).join("\n"),
        key === "changes" ? changesTitle : `Doctor ${key}`,
      );
    }
  }
}
