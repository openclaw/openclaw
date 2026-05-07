import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  fileName?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const transcriptPath = path.join(dir, params.fileName ?? `${params.sessionId}.jsonl`);
  return { dir, transcriptPath, sessionId: params.sessionId };
}
