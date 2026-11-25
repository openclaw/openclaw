const CRON_EXECUTION_ID_RE = /^cron:(.+):(\d+)$/u;

/**
 * Notifications link runs by execution id (`cron:<jobId>:<startedAtMs>`), while
 * ledger entries carry public run ids (receipt UUIDs, `manual:<...>` ids) that
 * never equal it. Forwarded cron messages link by transcript session id. Match
 * either exact id first, then the entry's recorded run start.
 */
export function cronRunEntryMatchesLink(
  linkedRunId: string,
  entry: { jobId: string; runId?: string; sessionId?: string; runAtMs?: number },
): boolean {
  if (entry.runId === linkedRunId || entry.sessionId === linkedRunId) {
    return true;
  }
  const match = CRON_EXECUTION_ID_RE.exec(linkedRunId);
  return match !== null && match[1] === entry.jobId && entry.runAtMs === Number(match[2]);
}
