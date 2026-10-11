export function resolveCronRouteData(search: string): {
  jobId: string | null;
  runId: string | null;
  session?: { sessionKey: string; sessionAgentId: string };
} {
  const params = new URLSearchParams(search);
  const jobId = params.get("job")?.trim() || null;
  const sessionKey = params.get("session")?.trim();
  const agentId = params.get("agent")?.trim();
  return {
    jobId,
    runId: jobId ? params.get("run")?.trim() || null : null,
    ...(!jobId && sessionKey && agentId
      ? { session: { sessionKey, sessionAgentId: agentId } }
      : {}),
  };
}
