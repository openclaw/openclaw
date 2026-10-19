import fs from "node:fs";
import path from "node:path";
import { resolveSessionFilePathCore } from "../config/sessions/paths.js";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { resolveRealpathOrAbsolute as canonicalFilePath } from "../infra/boundary-path.js";

export function resolveActiveSqliteTranscriptFile(
  target: SessionStoreTarget,
  entry: { sessionFile?: string; sessionId: string },
): string | undefined {
  let transcriptPath: string;
  try {
    transcriptPath = resolveSessionFilePathCore(entry.sessionId, entry, {
      agentId: target.agentId,
      sessionsDir: path.dirname(target.storePath),
    });
  } catch {
    return undefined;
  }
  if (!transcriptPath.endsWith(".jsonl")) {
    return undefined;
  }
  try {
    if (!fs.statSync(transcriptPath).isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const sessionsDir = canonicalFilePath(path.dirname(target.storePath));
  const activePath = canonicalFilePath(transcriptPath);
  return path.dirname(activePath) === sessionsDir ? activePath : undefined;
}
