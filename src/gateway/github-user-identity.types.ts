/** Connection-held identity synchronization contract, independent of its transport. */
type AuthenticatedGitHubIdentitySyncResult = { profileId: string; updatedAt: number };
export type AuthenticatedGitHubIdentitySync = () => Promise<AuthenticatedGitHubIdentitySyncResult>;
