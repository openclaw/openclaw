/** GitHub account IDs are host-scoped, so the image host follows the account's issuer. */
export function githubAccountAvatarUrl(host: string, accountId: number): string {
  return host === "github.com"
    ? `https://avatars.githubusercontent.com/u/${accountId}?v=4`
    : `https://${host}/avatars/u/${accountId}`;
}
