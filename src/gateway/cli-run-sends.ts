/**
 * In-process store for messaging tool sends that occur via the MCP loopback
 * server during a CLI agent run.  Keyed by runId so that cli-runner.ts can
 * drain the sends after the subprocess completes and decide whether to suppress
 * output.text (preventing the double-message problem).
 */

const sendsByRunId = new Map<string, string[]>();

/**
 * Record that a messaging tool send reached `targetChannelId` during `runId`.
 * Called from the MCP loopback HTTP handler after a successful message/send.
 */
export function recordCliRunSend(runId: string, targetChannelId: string): void {
  const existing = sendsByRunId.get(runId);
  if (existing) {
    existing.push(targetChannelId);
  } else {
    sendsByRunId.set(runId, [targetChannelId]);
  }
}

/**
 * Drain all recorded sends for `runId` and remove the entry.
 * Returns the list of channel IDs that were sent to during this run.
 * Safe to call multiple times — subsequent calls return [].
 */
export function drainCliRunSends(runId: string): string[] {
  const sends = sendsByRunId.get(runId) ?? [];
  sendsByRunId.delete(runId);
  return sends;
}
