import { note } from "../../../packages/terminal-core/src/note.js";
import { sanitizeDoctorNote } from "./emit-notes.js";

// Repair-mode "Doctor changes" panels queue until the final candidate passes the
// same validation the atomic writer enforces: printing "Doctor changes" and then
// refusing the write would report repairs that never reached disk. Preview
// panels print immediately — they promise nothing.
type DoctorChangesPanelSink = {
  emit: (changeLines: ReadonlyArray<string>, options?: { sanitize?: boolean }) => void;
  drain: () => string[];
};

export function createDoctorChangesPanelSink(shouldRepair: boolean): DoctorChangesPanelSink {
  const pending: string[] = [];
  return {
    emit: (changeLines, options = {}) => {
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
