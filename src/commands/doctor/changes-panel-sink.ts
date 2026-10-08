import { note } from "../../../packages/terminal-core/src/note.js";
import { sanitizeDoctorNote } from "./emit-notes.js";

// Repair-mode "Doctor changes" panels queue until the final candidate passes the
// same validation the atomic writer enforces: printing "Doctor changes" and then
// refusing the write would report repairs that never reached disk. Preview
// panels print immediately — they promise nothing.
export function createDoctorChangesPanelSink(shouldRepair: boolean) {
  const pending: string[] = [];
  return {
    emit: (changeLines: readonly string[], options: { sanitize?: boolean } = {}) => {
      if (changeLines.length === 0) {
        return;
      }
      const body = changeLines.join("\n");
      const message = options.sanitize ? sanitizeDoctorNote(body) : body;
      if (shouldRepair) {
        pending.push(message);
        return;
      }
      note(message, "Doctor changes preview");
    },
    drain: () => pending.splice(0),
  };
}
