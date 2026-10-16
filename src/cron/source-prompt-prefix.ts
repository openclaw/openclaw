/** Header prepended to cron agent-turn prompts and recorded as input provenance. */
export function formatCronSourcePromptPrefix(job: { id: string; name: string }): string {
  return `[cron:${job.id} ${job.name}]`;
}

/**
 * Reads the job name recorded when the run started. One-shot jobs are deleted
 * after they run, so their transcript rows keep no other name.
 */
export function readCronSourcePromptPrefixName(
  prefix: string | undefined,
  jobId: string,
): string | undefined {
  const head = `[cron:${jobId} `;
  if (!prefix?.startsWith(head) || !prefix.endsWith("]")) {
    return undefined;
  }
  return prefix.slice(head.length, -1).trim() || undefined;
}
