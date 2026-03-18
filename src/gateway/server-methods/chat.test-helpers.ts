import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";

export function createTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  fileName?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const transcriptPath = path.join(dir, params.fileName ?? "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  return { dir, transcriptPath };
}

export function createMockSessionEntry(params: {
  transcriptPath: string;
  sessionId: string;
  canonicalKey?: string;
  cfg?: Record<string, unknown>;
}) {
  return {
    cfg: params.cfg ?? {},
    storePath: path.join(path.dirname(params.transcriptPath), "sessions.json"),
    entry: {
      sessionId: params.sessionId,
      sessionFile: params.transcriptPath,
    },
    canonicalKey: params.canonicalKey ?? "main",
  };
}
