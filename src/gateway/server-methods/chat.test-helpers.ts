import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createSqliteTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  agentId?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  return { dir, agentId: params.agentId ?? "main", sessionId: params.sessionId };
}
