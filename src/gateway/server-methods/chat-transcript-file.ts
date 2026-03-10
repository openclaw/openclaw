import fs from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";

export async function ensureGatewayTranscriptFile(params: {
  transcriptPath: string;
  sessionId: string;
}) {
  await fs.mkdir(path.dirname(params.transcriptPath), { recursive: true });
  try {
    await fs.access(params.transcriptPath);
    return;
  } catch {
    // create below
  }
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.writeFile(params.transcriptPath, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}
