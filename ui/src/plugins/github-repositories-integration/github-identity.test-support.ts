import { createRoot, createSignal } from "solid-js";
import { createGitHubIdentityView } from "../../../../extensions/github-repositories/browser/github-identity-view.tsx";
import {
  createGitHubIdentity,
  type GitHubIdentity,
  settingsEnglish as english,
} from "../../../../extensions/github-repositories/browser/index.tsx";
import { readGitHubConfig } from "../../../../extensions/github-repositories/config-api.js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { trackSolidRoot } from "../../test-helpers/solid-cleanup.ts";
import { registerControlUiEnglish } from "../control-ui-english.ts";
registerControlUiEnglish(english);

export function createGitHubIdentityForTest(
  deps: Partial<Parameters<typeof createGitHubIdentity>[0]> = {},
) {
  return createRoot((dispose) => {
    const identity = createGitHubIdentityView({
      projectOwner: (source) => projectOwner(source, (owner) => owner.read()),
      translate: t,
      confirm: showConfirmDialog,
      formatError: formatUiError,
      ...deps,
    });
    type Sync = Parameters<typeof identity.sync>[0];
    type Target = NonNullable<Sync["target"]>;
    type Shared = Extract<Target, { kind: "shared" }>;
    return {
      ...identity,
      sync(
        params: Omit<Sync, "target"> & {
          target:
            | Extract<Target, { kind: "personal" }>
            | (Omit<Shared, "config"> & { config: Record<string, unknown> | null })
            | null;
        },
      ) {
        const target = params.target;
        const config = target?.kind === "shared" ? target.config : null;
        const selected = readGitHubConfig(config);
        identity.sync({
          ...params,
          target:
            target?.kind === "shared"
              ? {
                  ...target,
                  config: target.config
                    ? {
                        system: selected.system,
                        agent: selected.agents?.[target.agentId],
                      }
                    : null,
                }
              : target,
        });
      },
      dispose: trackSolidRoot(() => {
        identity.dispose();
        dispose();
      }),
    };
  });
}
export type TestGitHubIdentity = ReturnType<typeof createGitHubIdentityForTest>;
type IdentityState = ReturnType<GitHubIdentity["read"]>;

export function githubIdentityViewFixture(
  overrides: Partial<IdentityState> = {},
): ReturnType<typeof createGitHubIdentityView> {
  const state: IdentityState = {
    status: null,
    personal: null,
    system: null,
    loading: false,
    busy: false,
    error: null,
    statusCompletion: overrides.loading ? new Promise<void>(() => {}) : undefined,
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
  const saving = createRoot((dispose) => {
    trackSolidRoot(dispose);
    return createSignal(state.busy)[0];
  });
  return {
    read: () => state,
    saving,
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

export function createGitHubIdentityViewForTest(
  deps: Partial<Parameters<typeof createGitHubIdentityView>[0]> = {},
) {
  return createGitHubIdentityView({
    projectOwner: (source) => projectOwner(source, (owner) => owner.read()),
    translate: t,
    confirm: showConfirmDialog,
    formatError: formatUiError,
    ...deps,
  });
}
