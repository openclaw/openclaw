import type { CachedGitHubIdentity } from "../state/user-profiles.types.js";

/** Connection-held identity synchronization contract, independent of its transport. */
type AuthenticatedGitHubIdentitySyncResult = CachedGitHubIdentity & {
  enterprise?: { accountId: number; login: string; avatarUrl?: string };
};
export type AuthenticatedGitHubIdentitySync = () => Promise<AuthenticatedGitHubIdentitySyncResult>;

export type GitHubIdentityPreparationTiming =
  | "profileAccessIdentityMs"
  | "profileGitHubMetadataMs"
  | "profileBindingReadMs"
  | "profileWriteMs";
