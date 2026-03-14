import {
  ensureAuthProfileStore,
  listProfilesForProvider,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { loadModelsConfig } from "./load-config.js";
import { updateConfig } from "./shared.js";

const DEFAULT_PROFILE_PROVIDER = "openai-codex";

function resolveExistingOrder(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
}): string[] {
  const configured = findNormalizedProviderValue(params.cfg.auth?.order, params.provider);
  const stored = findNormalizedProviderValue(params.store.order, params.provider);
  return normalizeStringEntries([...(configured ?? []), ...(stored ?? [])]);
}

function buildGlobalProfileOrder(params: {
  selectedProfileId: string;
  existingOrder: string[];
  availableProfiles: string[];
}): string[] {
  const availableSet = new Set(params.availableProfiles);
  const ordered = normalizeStringEntries([
    params.selectedProfileId,
    ...params.existingOrder,
    ...params.availableProfiles,
  ]).filter((profileId) => availableSet.has(profileId));
  return [...new Set(ordered)];
}

function formatAvailableProfiles(profileIds: string[]): string {
  return profileIds.length > 0 ? profileIds.join(", ") : "(none)";
}

export async function modelsAuthProfileUseCommand(
  opts: { profileId: string; provider?: string },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error("Missing profile id.");
  }

  const provider = normalizeProviderId(opts.provider?.trim() || DEFAULT_PROFILE_PROVIDER);
  const cfg = await loadModelsConfig({
    commandName: "models auth profile use",
    runtime,
  });
  const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });
  const availableProfiles = listProfilesForProvider(store, provider);
  const selectedCredential = store.profiles[profileId];

  if (!selectedCredential) {
    throw new Error(
      `Auth profile "${profileId}" not found. Available for ${provider}: ${formatAvailableProfiles(availableProfiles)}.`,
    );
  }
  if (normalizeProviderId(selectedCredential.provider) !== provider) {
    throw new Error(
      `Auth profile "${profileId}" is for ${selectedCredential.provider}, not ${provider}.`,
    );
  }
  if (availableProfiles.length === 0) {
    throw new Error(`No auth profiles found for ${provider}.`);
  }

  const existingOrder = resolveExistingOrder({
    cfg,
    store,
    provider,
  });
  const nextOrder = buildGlobalProfileOrder({
    selectedProfileId: profileId,
    existingOrder,
    availableProfiles,
  });
  if (nextOrder.length === 0) {
    throw new Error(`No usable auth profiles found for ${provider}.`);
  }

  await updateConfig((current) => ({
    ...current,
    auth: {
      ...current.auth,
      order: {
        ...current.auth?.order,
        [provider]: nextOrder,
      },
    },
  }));

  runtime.log(`Provider: ${provider}`);
  runtime.log(`Selected profile: ${profileId}`);
  runtime.log(`Global auth order: ${nextOrder.join(", ")}`);
  runtime.log(
    "Note: per-agent auth order overrides in auth-profiles.json still take precedence over global auth.order.",
  );
}
