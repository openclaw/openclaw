import { sanitizeForLog } from "../../terminal/ansi.js";

export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const change of params.changeNotes ?? []) {
    params.note(sanitizeForLog(change), "Doctor changes");
  }
  for (const warning of params.warningNotes ?? []) {
    params.note(sanitizeForLog(warning), "Doctor warnings");
  }
}
