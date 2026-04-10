import type {
  AuthProfileCredential,
  AuthProfileStore,
} from "../agents/auth-profiles/types.js";
import type { ModelProviderAuthMode, ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ProviderResolveSyntheticAuthContext = {
  config?: OpenClawConfig;
  provider: string;
  providerConfig?: ModelProviderConfig;
};

export type ProviderSyntheticAuthResult = {
  apiKey: string;
  source: string;
  mode: Exclude<ModelProviderAuthMode, "aws-sdk">;
};

export type ProviderResolveExternalOAuthProfilesContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  store: AuthProfileStore;
};

export type ProviderResolveExternalAuthProfilesContext =
  ProviderResolveExternalOAuthProfilesContext;

export type ProviderExternalOAuthProfile = {
  profileId: string;
  credential: AuthProfileCredential;
  persistence?: "runtime-only" | "persisted";
  /**
   * Optional auth-selection priority for runtime overlays.
   * Use `highest` for temporary live overrides that should run before
   * configured/stored credentials without replacing them on disk.
   */
  selectionPriority?: "default" | "highest";
};

export type ProviderExternalAuthProfile = ProviderExternalOAuthProfile;
