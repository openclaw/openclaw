import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";

export async function seedLinearTranscript(params: {
  contents: string[];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await persistSessionTranscriptTurn(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      updateMode: "none",
      messages: params.contents.map((content, index) => ({
        message: { role: "user", content, timestamp: index + 1 },
        now: Date.parse(`2026-06-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`),
      })),
    },
  );
}

export async function loadTranscriptRows(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await loadTranscriptEvents({ agentId: "main", ...params });
}
