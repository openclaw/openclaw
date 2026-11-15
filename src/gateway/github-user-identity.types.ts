import type { ExistingUserProfileAuthentication } from "../state/user-profile-reads.js";
import type { CachedGitHubIdentity } from "../state/user-profiles.types.js";

/** Connection-held identity synchronization contract, independent of its transport. */
type AuthenticatedGitHubIdentitySyncResult = CachedGitHubIdentity & {
  enterprise?: { accountId: number; login: string; avatarUrl?: string };
};
export type AuthenticatedGitHubIdentitySync = {
  (): Promise<AuthenticatedGitHubIdentitySyncResult>;
  existingAuthentication?: () => Promise<ExistingUserProfileAuthentication>;
};

export type GitHubIdentityPreparationTiming =
  | "profileAccessIdentityMs"
  | "profileGitHubMetadataMs"
  | "profileBindingReadMs"
  | "profileWriteMs";

export type RepositoryCredentialSource =
  import("../plugins/repository-integration.types.js").RepositoryConnectionIdentity["credentialSource"];
