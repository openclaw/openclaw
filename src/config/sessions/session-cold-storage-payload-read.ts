import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  readSessionColdChunks,
  readVerifiedSessionColdChunk,
} from "./session-cold-storage-chunks.js";
import { decodeSessionColdRecords } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";

/** Payload resolution belongs to one admitted history snapshot, never to a process cache. */
export function createSessionColdPayloadReader(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
) {
  const archive = readSessionColdTranscript(database.db, sessionId);
  if (!archive) {
    return undefined;
  }
  const chunks = readSessionColdChunks(database.db, archive);
  let loadedIndex: number | undefined;
  let payloads = new Map<number, string>();
  return (seq: number): string => {
    let low = 0;
    let high = chunks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (chunks[middle]!.last_seq < seq) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const chunk = chunks[low];
    if (chunks.length && (!chunk || seq < chunk.first_seq)) {
      throw new Error("Cold transcript payload is absent from the verified manifest");
    }
    const index = chunk?.chunk_index ?? -1;
    if (loadedIndex !== index) {
      payloads = new Map();
      const selected = readVerifiedSessionColdChunk(database.db, database.path, archive, chunk);
      // Exhaust verification before returning any selected payload. Keep only this bounded chunk.
      for (const record of decodeSessionColdRecords(selected.bytes, selected.archive)) {
        if (record.kind === "event") {
          payloads.set(record.row.seq, record.row.event_json);
        }
      }
      loadedIndex = index;
    }
    const payload = payloads.get(seq);
    if (payload === undefined) {
      throw new Error("Cold transcript payload is absent from its verified chunk");
    }
    return payload;
  };
}
