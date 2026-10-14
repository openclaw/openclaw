import path from "node:path";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsStore } from "./store.js";

export function createTranscriptLibraryStoreFixture(stateDir: string) {
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  return {
    stateDir,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), options),
    database: () => openOpenClawStateDatabase(options).db,
  };
}

export function transcriptLibrarySession(
  sessionId: string,
  overrides: Partial<TranscriptSessionDescriptor> = {},
): TranscriptSessionDescriptor {
  return {
    sessionId,
    title: sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}
