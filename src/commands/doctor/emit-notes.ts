import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { HealthFinding } from "../../flows/health-checks.js";

/** Strip terminal control sequences from a potentially multi-line doctor note. */
export function sanitizeDoctorNote(note: string): string {
  return note.split("\n").map(sanitizeForLog).join("\n");
}

export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  infoNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const [title, notes] of [
    ["Doctor changes", params.changeNotes],
    ["Doctor info", params.infoNotes],
    ["Doctor warnings", params.warningNotes],
  ] as const) {
    for (const message of notes ?? []) {
      params.note(sanitizeDoctorNote(message), title);
    }
  }
}

/** Keep structured findings out of legacy warning panels while preserving change publication. */
export function emitDoctorRepairSequenceNotes(params: {
  note: (message: string, title?: string) => void;
  repairSequence: {
    changeNotes: string[];
    warningNotes: string[];
    displayWarningNotes: string[];
    configChangeNotes?: string[];
  };
  structuredWarnings: boolean;
  emitConfigChange: (change: string) => void;
}): void {
  const sequence = params.repairSequence;
  emitDoctorNotes({
    note: params.note,
    changeNotes: sequence.changeNotes,
    warningNotes: params.structuredWarnings ? sequence.displayWarningNotes : sequence.warningNotes,
  });
  for (const change of sequence.configChangeNotes ?? []) {
    params.emitConfigChange(change);
  }
}

export type DoctorFindingReporter = (
  findings: readonly HealthFinding[],
  warnings?: readonly string[],
) => void;
