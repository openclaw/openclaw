/** Command for removing one saved model auth profile. */
import { isDeepStrictEqual } from "node:util";
import {
  type AuthProfileCredential,
  type AuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  loadAuthProfileStoreWithoutExternalProfiles,
  removeAuthProfilesAcrossOwnerStores,
} from "../../agents/auth-profiles.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  configReferencesAuthProfile,
  removeAuthProfileConfig,
} from "../../plugins/provider-auth-helpers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent, updateConfig } from "./shared.js";

const MISSING_CONFIG_VALUE = Symbol("missing-config-value");

function asConfigRecord(value: unknown): Record<string, unknown> | undefined {
  if (
    value === MISSING_CONFIG_VALUE ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  // SAFETY: The branch proves this is a non-null, non-array object.
  return value as Record<string, unknown>;
}

function restoreConfigMutationValue(current: unknown, before: unknown, after: unknown): unknown {
  // Restore only cleanup-owned values that no later config writer changed.
  if (isDeepStrictEqual(before, after)) {
    return current;
  }
  if (isDeepStrictEqual(current, after)) {
    return before;
  }
  const currentRecord = asConfigRecord(current);
  const beforeRecord = asConfigRecord(before);
  const afterRecord = asConfigRecord(after);
  if (!currentRecord || !beforeRecord || !afterRecord) {
    return current;
  }
  const restored = { ...currentRecord };
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
  for (const key of keys) {
    const value = restoreConfigMutationValue(
      Object.hasOwn(currentRecord, key) ? currentRecord[key] : MISSING_CONFIG_VALUE,
      Object.hasOwn(beforeRecord, key) ? beforeRecord[key] : MISSING_CONFIG_VALUE,
      Object.hasOwn(afterRecord, key) ? afterRecord[key] : MISSING_CONFIG_VALUE,
    );
    if (value === MISSING_CONFIG_VALUE) {
      delete restored[key];
    } else {
      restored[key] = value;
    }
  }
  return restored;
}

function restoreCredentialConfigMutation(params: {
  current: OpenClawConfig;
  before: OpenClawConfig;
  after: OpenClawConfig;
}): OpenClawConfig {
  // SAFETY: Restoration selects or rebuilds fields from three validated OpenClawConfig values.
  return restoreConfigMutationValue(params.current, params.before, params.after) as OpenClawConfig;
}

function restoreSurvivingProfileOrder(params: {
  desired: OpenClawConfig;
  before: OpenClawConfig;
  after: OpenClawConfig;
  survivingProfileIds: ReadonlySet<string>;
}): OpenClawConfig {
  const order = { ...params.after.auth?.order };
  for (const [provider, beforeOrder] of Object.entries(params.before.auth?.order ?? {})) {
    const afterOrder = params.after.auth?.order?.[provider] ?? [];
    const restored = beforeOrder.filter(
      (profileId) => afterOrder.includes(profileId) || params.survivingProfileIds.has(profileId),
    );
    for (const profileId of afterOrder) {
      if (!restored.includes(profileId)) {
        restored.push(profileId);
      }
    }
    if (restored.length > 0 || Object.hasOwn(order, provider)) {
      order[provider] = restored;
    }
  }
  if (Object.keys(order).length === 0 && !params.desired.auth) {
    return params.desired;
  }
  const { order: _removedOrder, ...auth } = params.desired.auth ?? {};
  return {
    ...params.desired,
    auth: {
      ...auth,
      ...(Object.keys(order).length > 0 ? { order } : {}),
    },
  };
}

function removeCredentialConfigReferences(params: {
  current: OpenClawConfig;
  profileIds: readonly string[];
  store: AuthProfileStore;
  apiKeyProvider?: string;
}): OpenClawConfig {
  let next = params.current;
  for (const id of params.profileIds) {
    next = removeAuthProfileConfig(next, id);
  }
  if (params.apiKeyProvider === undefined || !next.models?.providers) {
    return next;
  }
  const owner = resolveProviderIdForAuth(params.apiKeyProvider, { config: next });
  const providers = { ...next.models.providers };
  for (const [provider, entry] of Object.entries(providers)) {
    if (
      resolveProviderIdForAuth(provider, { config: next }) === owner &&
      resolveProviderEntryApiKeyProfileReference({
        cfg: next,
        provider,
        store: params.store,
      }).kind === "literal"
    ) {
      const { apiKey: _removed, ...connection } = entry;
      providers[provider] = connection;
    }
  }
  return { ...next, models: { ...next.models, providers } };
}

/** Clears selected config references before deleting the credentials they name. */
export async function removeModelAuthCredentials(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  profileIds: readonly string[];
  apiKeyProvider?: string;
  provider?: string;
}): Promise<void> {
  const apiKeyProvider = params.apiKeyProvider;
  let cleanup:
    | {
        before: OpenClawConfig;
        after: OpenClawConfig;
        profileIds: readonly string[];
      }
    | undefined;
  const beforeRemove = async (profileIds: readonly string[]) => {
    await updateConfig((current) => {
      const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
        allowKeychainPrompt: false,
      });
      if (
        apiKeyProvider !== undefined &&
        profileIds.some((id) => {
          const credential = store.profiles[id];
          return (
            credential?.type !== "api_key" ||
            Boolean(credential.keyRef) ||
            resolveProviderIdForAuth(credential.provider, {
              config: current,
              storedCredential: true,
            }) !== resolveProviderIdForAuth(apiKeyProvider, { config: current })
          );
        })
      ) {
        throw new Error("The selected API key changed. Reload Models and retry removal.");
      }
      const next = removeCredentialConfigReferences({
        current,
        profileIds,
        store,
        ...(apiKeyProvider !== undefined ? { apiKeyProvider } : {}),
      });
      cleanup = { before: current, after: next, profileIds };
      return next;
    });
  };
  const restoreIncompleteRemoval = async (
    survivingProfiles: ReadonlyMap<string, AuthProfileCredential>,
  ) => {
    const cleanupState = cleanup;
    if (!cleanupState) {
      return;
    }
    const survivingProfileIds = new Set(survivingProfiles.keys());
    let withoutSurvivors = cleanupState.before;
    for (const profileId of cleanupState.profileIds) {
      if (survivingProfileIds.has(profileId)) {
        withoutSurvivors = removeAuthProfileConfig(withoutSurvivors, profileId);
      }
    }
    const desired = restoreSurvivingProfileOrder({
      desired: restoreCredentialConfigMutation({
        current: cleanupState.after,
        before: cleanupState.before,
        after: withoutSurvivors,
      }),
      before: cleanupState.before,
      after: cleanupState.after,
      survivingProfileIds,
    });
    await updateConfig((current) =>
      restoreCredentialConfigMutation({
        current,
        before: desired,
        after: cleanupState.after,
      }),
    );
  };
  const removed = await removeAuthProfilesAcrossOwnerStores({
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileIds: params.profileIds,
    beforeRemove,
    onIncomplete: restoreIncompleteRemoval,
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
  });
  if (!removed) {
    throw new Error("Saved credentials could not be removed. Wait a moment and retry.");
  }
}

/** Removes a saved auth profile from the agent auth store and from config. */
export async function modelsAuthLogoutCommand(
  opts: { profileId: string; agent?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  const profileId = opts.profileId?.trim();
  if (!profileId) {
    throw new Error(
      `Missing profile id. Run ${formatCliCommand("openclaw models auth list")} to see saved profile ids.`,
    );
  }

  const cfg = await loadModelsConfig({ commandName: "models auth logout", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent, { kind: "mutation" });
  // External CLI overlays (Claude/Codex CLI) are not ours to delete, so the
  // removable set is exactly the persisted store.
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
  const credential = store.profiles[profileId];
  if (!credential) {
    throw new Error(
      `Auth profile "${profileId}" not found for agent "${agentId}". Run ${formatCliCommand(`openclaw models auth list --agent ${agentId}`)} to see saved profile ids.`,
    );
  }

  const description = `${profileId} (${credential.provider}/${credential.type})`;
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Refusing to remove auth profile ${description} without confirmation. Pass --yes to remove it non-interactively.`,
      );
    }
    const proceed = await createClackPrompter().confirm({
      message: `Remove auth profile ${description} from agent ${agentId}?`,
      initialValue: false,
    });
    if (!proceed) {
      runtime.log("Cancelled.");
      return;
    }
  }

  // Config first: `auth.profiles`/`auth.order` are a separate surface from the
  // store, and a failed config write after the credential is gone would leave a
  // dangling reference that logout can no longer repair (the profile lookup
  // above would then fail). This order makes a partial failure retryable.
  await removeModelAuthCredentials({ cfg, agentDir, profileIds: [profileId] });
  if (configReferencesAuthProfile(cfg, profileId)) {
    logConfigUpdated(runtime);
  }

  await refreshRunningGatewayAuthState(agentId, "logout", runtime);

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Removed auth profile: ${description}`);
  const remaining = listProfilesForProvider(store, credential.provider).filter(
    (id) => id !== profileId,
  );
  if (remaining.length === 0) {
    runtime.log(
      `No auth profiles remain for ${credential.provider}. Run ${formatCliCommand(`openclaw models auth login --provider ${credential.provider}`)} to sign in again.`,
    );
  }
}
