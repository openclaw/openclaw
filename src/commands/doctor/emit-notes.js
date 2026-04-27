import { sanitizeForLog } from "../../terminal/ansi.js";
export function sanitizeDoctorNote(note) {
    return note
        .split("\n")
        .map((line) => sanitizeForLog(line))
        .join("\n");
}
export function emitDoctorNotes(params) {
    for (const change of params.changeNotes ?? []) {
        params.note(sanitizeDoctorNote(change), "Doctor changes");
    }
    for (const warning of params.warningNotes ?? []) {
        params.note(sanitizeDoctorNote(warning), "Doctor warnings");
    }
}
