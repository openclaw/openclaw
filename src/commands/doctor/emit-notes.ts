// Doctor note emission helpers that sanitize user-visible repair output.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";

/** Strip terminal control sequences from a potentially multi-line doctor note. */
export function sanitizeDoctorNote(note: string): string {
  return note
    .split("\n")
    .map((line) => sanitizeForLog(line))
    .join("\n");
}

/** Emit grouped doctor change, info, and warning notes with sanitized content. */
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
