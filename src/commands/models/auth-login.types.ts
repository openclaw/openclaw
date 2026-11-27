import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { ProviderModelAccess } from "./auth-model-policy.js";
import type { ModelAuthRefreshOutcome } from "./auth-refresh.js";

export type ModelsAuthLoginOptions = {
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /** A host running the login can publish credentials into its own runtime. */
  refreshAfterLogin?: (agentId: string) => Promise<void>;
  provider?: string;
  method?: string;
  profileId?: string;
  setDefault?: boolean;
  yes?: boolean;
  agent?: string;
  /** Discard cached provider profiles before starting a replacement login. */
  force?: boolean;
};

export type ModelsAuthLoginFlowResult = {
  providerId: string;
  methodId: string;
  authRefresh: ModelAuthRefreshOutcome;
  defaultModel?: string;
  imported?: boolean;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
  /** Set when saving the credential added the provider to the model allowlist. */
  modelAccess?: ProviderModelAccess;
};

export type ModelsAuthLoginFlowOptions = ModelsAuthLoginOptions & {
  ownerPluginId?: string;
  credentialOnly?: boolean;
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  openUrl?: (url: string) => Promise<void>;
  nodes?: ProviderAuthContext["nodes"];
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
};
