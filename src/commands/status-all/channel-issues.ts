/**
 * Groups gateway-reported channel issues by plugin id while preserving the
 * original issue order for first-issue table summaries.
 */
export function groupChannelIssuesByChannel<T extends { channel: string }>(
  issues: readonly T[],
): Map<string, T[]> {
  const byChannel = new Map<string, T[]>();
  for (const issue of issues) {
    const key = issue.channel;
    const list = byChannel.get(key);
    if (list) {
      list.push(issue);
    } else {
      byChannel.set(key, [issue]);
    }
  }
  return byChannel;
}
