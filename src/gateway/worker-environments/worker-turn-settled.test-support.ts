import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  openSessionManager,
  readWorkerTurnTranscriptStorageRows,
} from "./worker-turn-launcher.test-support.js";

/** Entries and rows a settled turn kept, without the prompt checkpoint it appends last. */
export async function settledTurn(committedRowCount: number) {
  const entries = (await openSessionManager()).getPersistedEntries();
  return [
    entries.filter(
      (entry) =>
        !(
          isRecord(entry) &&
          entry.type === "custom" &&
          entry.customType === "openclaw.system-prompt"
        ),
    ),
    readWorkerTurnTranscriptStorageRows().slice(0, committedRowCount),
  ];
}
