// Shared types for applying auth-choice selections during onboarding and agent setup.
import type { applyAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import type { ProviderAuthResult } from "../plugins/types.js";
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

export type ApplyAuthChoiceParams = Omit<
  Parameters<typeof applyAuthChoiceLoadedPluginProvider>[0],
  "authChoice" | "opts" | "signal" | "isRemote" | "beforePersistentEffect"
> & {
  authChoice: AuthChoice;
  /** Cancels provider authentication that is still polling or exchanging tokens. */
  signal?: AbortSignal;
  opts?: Partial<OnboardOptions>;
};

export type ApplyAuthChoiceResult = NonNullable<
  Awaited<ReturnType<typeof applyAuthChoiceLoadedPluginProvider>>
>;

export type PreparedAuthChoiceResult = ApplyAuthChoiceResult & {
  authProfiles: ProviderAuthResult["profiles"];
  persistAuthProfiles: (profiles?: ProviderAuthResult["profiles"]) => Promise<void>;
};
