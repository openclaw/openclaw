export function diagnosticSessionRefs(params: {
  sessionId?: string;
  sessionKey?: string;
}): string[] {
  const refs: string[] = [];
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (sessionId) {
    refs.push(`id:${sessionId}`);
  }
  if (sessionKey) {
    refs.push(`key:${sessionKey}`);
  }
  return refs;
}

export function diagnosticToolActivityKey(event: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolCallId?: string;
  toolName: string;
}): string {
  return `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${
    event.toolCallId ?? event.toolName
  }`;
}

export function diagnosticModelCallActivityKey(event: {
  runId?: string;
  provider?: string;
  model?: string;
}): string {
  return `${event.runId ?? "unknown"}:${event.provider ?? "provider"}:${event.model ?? "model"}`;
}
