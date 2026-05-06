const COMPACTION_CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i;

export function parseCompactionCheckpointTranscriptFileName(fileName: string): {
  sessionId: string;
  checkpointId: string;
} | null {
  const match = COMPACTION_CHECKPOINT_TRANSCRIPT_RE.exec(fileName);
  const sessionId = match?.[1];
  const checkpointId = match?.[2];
  return sessionId && checkpointId ? { sessionId, checkpointId } : null;
}

export function isCompactionCheckpointTranscriptFileName(fileName: string): boolean {
  return parseCompactionCheckpointTranscriptFileName(fileName) !== null;
}

export function isTrajectoryRuntimeArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory.jsonl");
}

export function isTrajectoryPointerArtifactName(fileName: string): boolean {
  return fileName.endsWith(".trajectory-path.json");
}

export function isTrajectorySessionArtifactName(fileName: string): boolean {
  return isTrajectoryRuntimeArtifactName(fileName) || isTrajectoryPointerArtifactName(fileName);
}

export function isPrimarySessionTranscriptFileName(fileName: string): boolean {
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

export function isUsageCountedSessionTranscriptFileName(fileName: string): boolean {
  return isPrimarySessionTranscriptFileName(fileName);
}

export function parseUsageCountedSessionIdFromFileName(fileName: string): string | null {
  if (isPrimarySessionTranscriptFileName(fileName)) {
    return fileName.slice(0, -".jsonl".length);
  }
  return null;
}

export function formatFilesystemTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().replaceAll(":", "-");
}
