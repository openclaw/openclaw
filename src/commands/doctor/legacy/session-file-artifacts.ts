import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  isCompactionCheckpointTranscriptFileName,
  isTrajectoryRuntimeArtifactName,
} from "../../../config/sessions/artifacts.js";
import { resolveRequiredHomeDir } from "../../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";

function resolveLegacyAgentSessionsDir(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}

export function resolveLegacySessionTranscriptsDirForAgent(
  agentId?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => resolveRequiredHomeDir(env, os.homedir),
): string {
  return resolveLegacyAgentSessionsDir(agentId, env, homedir);
}

export function isPrimaryLegacySessionTranscriptFileName(fileName: string): boolean {
  if (fileName === "sessions.json") {
    return false;
  }
  if (!fileName.endsWith(".jsonl")) {
    return false;
  }
  if (isTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isCompactionCheckpointTranscriptFileName(fileName)) {
    return false;
  }
  return true;
}
