import { createRoot } from "solid-js";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
import { createGitHubIdentity, type GitHubIdentity } from "./github-identity.ts";

export function createGitHubIdentityForTest(deps: Parameters<typeof createGitHubIdentity>[0] = {}) {
  return createRoot((dispose) => ({
    ...createGitHubIdentity(deps),
    dispose: trackSolidRoot(dispose),
  }));
}
export type TestGitHubIdentity = ReturnType<typeof createGitHubIdentityForTest>;
type IdentityState = ReturnType<GitHubIdentity["read"]>;

export function githubIdentityViewFixture(overrides: Partial<IdentityState> = {}): GitHubIdentity {
  const state: IdentityState = {
    status: null,
    personal: null,
    system: null,
    loading: false,
    busy: false,
    error: null,
    statusReadable: true,
    configurable: false,
    authorizable: false,
    scope: "agent",
    connectionReady: false,
    draft: { token: "", name: "", email: "" },
    authorization: { phase: "idle" },
    authorizationActive: false,
    tokenRevealed: false,
    patVisible: false,
    ...overrides,
  };
  return {
    read: () => state,
    sync() {},
    ensureVerified() {},
    setDraft() {},
    showPatFallback() {},
    hidePatFallback() {},
    toggleTokenVisibility() {},
    async verify() {},
    async startAuthorization() {},
    async cancelAuthorization() {},
    async configure() {},
    async inherit() {},
    async disconnect() {},
  };
}
