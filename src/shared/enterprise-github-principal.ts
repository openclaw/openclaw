/** Enterprise GitHub principals retain the issuer so equal account IDs on different hosts stay distinct. */
export function parseEnterpriseGitHubPrincipal(principal: string) {
  const match = /^github:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([1-9][0-9]*)$/u.exec(principal);
  const host = match?.[1];
  const subject = match?.[2];
  if (!host || !subject || host === "github.com" || host.includes("..")) {
    return undefined;
  }
  const accountId = Number(subject);
  return Number.isSafeInteger(accountId) ? { host, accountId } : undefined;
}
