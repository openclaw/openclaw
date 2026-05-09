import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteSessionTranscriptLocator } from "../../config/sessions/paths.js";

export function createSqliteTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  agentId?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const transcriptLocator = createSqliteSessionTranscriptLocator({
    agentId: params.agentId ?? "main",
    sessionId: params.sessionId,
  });
  return { dir, transcriptLocator, sessionId: params.sessionId };
}
