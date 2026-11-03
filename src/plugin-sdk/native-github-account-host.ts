/** Bridge to existing native GitHub account records. This does not define a generic account store. */
/** Canonical admitted OAuth-record reads; the plugin owns credential selection and refresh policy. */
export {
  inspectGitHubOAuthRecord,
  parseGitHubOAuthRecord,
  listGitHubOAuthRecords,
} from "../agents/github-oauth-records.js";

export {
  createRepositoryOAuthStateHostV1 as createNativeGitHubOAuthStateHostV1,
  type RepositoryOAuthStateHostV1 as NativeGitHubOAuthStateHostV1,
} from "../gateway/github-oauth-lifecycle-host.js";

export { consumeGitHubSetupHandoff } from "../secrets/store/secret-store.js";

export {
  matchesAgentLifecycleBinding,
  matchesAgentLifecycleBindingAsync,
} from "../agents/agent-lifecycle-registry.js";
export type { AgentLifecycleBinding } from "../agents/agent-lifecycle-registry.js";

export type {
  GitHubDeviceAuthorizationRecord as NativeGitHubDeviceAuthorizationRecord,
  GitHubIdentityScope as NativeGitHubIdentityScope,
  GitHubOAuthRecord as NativeGitHubOAuthRecord,
  GitHubOAuthTokenPair as NativeGitHubOAuthTokenPair,
  GitHubToolAccount as NativeGitHubToolAccount,
} from "../agents/github-oauth-records.js";
export {
  MANAGED_GITHUB_PROFILE_ID_PATTERN,
  isManagedGitHubProfileId,
} from "../config/github-identity-profile-id.js";

export type { GitHubRepositoryAdmissionRequest as NativeGitHubRepositoryAdmissionRequest } from "../agents/github-credential-reader.js";

/** Canonical native personal-account records. Storage admission and commit publication stay with their existing worker owner. */
export {
  prepareUserGitHubConnection,
  requirePendingUserGitHubConnection,
  readUserGitHubConnectionAsync,
  readCanonicalUserGitHubConnectionAsync,
  listUserGitHubConnectionsAsync,
} from "../state/user-github-connections.js";
export type {
  UserGitHubConnection as NativeGitHubUserConnection,
  UserGitHubConnected as NativeGitHubUserConnected,
  UserGitHubDevice as NativeGitHubUserDevice,
} from "../state/user-github-connections.js";
export { createRepositoryPersonalAccountHostV1 as createNativeGitHubPersonalAccountHostV1 } from "../state/repository-personal-account-host.js";

// Released synchronous personal OAuth members retain their existing native adapter through 2026-12-31.
export {
  cancelUserGitHubAuthorizationSync,
  disconnectUserGitHubConnectionSync,
} from "../state/user-github-connections.js";

export { UserGitHubConnectionAuthorityChangedError } from "../state/user-github-connections.js";

/** Deprecated shipped lookup; load instance machinery only for an admitted managed service start. */
export async function installNativeGitHubLegacyOAuthLookup(
  ...args: Parameters<
    typeof import("../gateway/native-github-account-install.js").installRepositoryLegacyOAuthLookup
  >
): Promise<
  ReturnType<
    typeof import("../gateway/native-github-account-install.js").installRepositoryLegacyOAuthLookup
  >
> {
  const runtime = await import("../gateway/native-github-account-install.js");
  return runtime.installRepositoryLegacyOAuthLookup(...args);
}
export type {
  LegacyGitHubOAuthService,
  LegacyPersonalGitHubService,
} from "../gateway/github-oauth-lifecycle-host.types.js";

// Native identity and receipt realms are independent of optional repository services.
export {
  GITHUB_PUBLIC_HOST,
  resolveConfiguredGitHubHost,
  resolveConfiguredGitHubApiBaseUrl,
} from "../gateway/native-github-host-realm.js";

/** Native sign-in and repository readers share the canonical service credential selector. */
export {
  githubApiToken,
  hasConfiguredGitHubApiCredential,
} from "../gateway/native-github-service-credential.js";
