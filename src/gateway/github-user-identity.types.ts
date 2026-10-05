/** Connection-held identity synchronization contract, independent of its transport. */
type AuthenticatedGitHubIdentitySyncResult = {
  profileId: string;
  updatedAt: number;
  factory?: { accountId: number; login: string; avatarUrl?: string };
};
export type AuthenticatedGitHubIdentitySync = () => Promise<AuthenticatedGitHubIdentitySyncResult>;
