import { createRoot, createSignal } from "solid-js";
import {
  createGitHubIdentityView,
  type GitHubIdentityView,
} from "../../lib/reactive/domain-github-identity.ts";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
import type { createGitHubIdentity } from "./github-identity.ts";

export function createGitHubIdentityForTest(
  deps: Parameters<typeof createGitHubIdentityView>[0] = {},
) {
  return createRoot((dispose) => {
    const identity = createGitHubIdentityView(deps);
    return {
      ...identity,
      dispose: trackSolidRoot(() => {
        identity.dispose();
        dispose();
      }),
    };
  });
}
export type TestGitHubIdentity = ReturnType<typeof createGitHubIdentityForTest>;
type IdentityState = ReturnType<ReturnType<typeof createGitHubIdentity>["read"]>;

export function githubIdentityViewFixture(
  overrides: Partial<IdentityState> = {},
): GitHubIdentityView {
  const state: IdentityState = {
    status: null,
    personal: null,
    system: null,
    loading: false,
    busy: false,
    error: null,
    statusCompletion: undefined,
    mutationCompletion: undefined,
    completion: undefined,
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
    saving: createSignal(state.busy)[0],
    subscribe: () => () => {},
    dispose() {},
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
