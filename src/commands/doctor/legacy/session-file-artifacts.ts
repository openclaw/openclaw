import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { resolveRequiredHomeDir } from "../../../infra/home-dir.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";

const LEGACY_COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

function isLegacyCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return LEGACY_COMPACTION_CHECKPOINT_TRANSCRIPT_RE.test(fileName);
}

function isLegacyTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

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
  if (isLegacyTrajectoryRuntimeArtifactName(fileName)) {
    return false;
  }
  if (isLegacyCompactionCheckpointTranscriptFileName(fileName)) {
    return false;
  }
  return true;
}
