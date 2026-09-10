/** Command for removing one saved model auth profile. */
import {
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

/** Clears selected config references before deleting the credentials they name. */
export async function removeModelAuthCredentials(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  profileIds: readonly string[];
  apiKeyProvider?: string;
  provider?: string;
}): Promise<void> {
  const apiKeyProvider = params.apiKeyProvider;
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
      let next = current;
      for (const id of profileIds) {
        next = removeAuthProfileConfig(next, id);
      }
      if (apiKeyProvider !== undefined && next.models?.providers) {
        const owner = resolveProviderIdForAuth(apiKeyProvider, { config: next });
        const providers = { ...next.models.providers };
        for (const [provider, entry] of Object.entries(providers)) {
          if (
            resolveProviderIdForAuth(provider, { config: next }) === owner &&
            resolveProviderEntryApiKeyProfileReference({ cfg: next, provider, store }).kind ===
              "literal"
          ) {
            const { apiKey: _removed, ...connection } = entry;
            providers[provider] = connection;
          }
        }
        next = { ...next, models: { ...next.models, providers } };
      }
      return next;
    });
  };
  if (
    !(await removeAuthProfilesAcrossOwnerStores({
      cfg: params.cfg,
      agentDir: params.agentDir,
      profileIds: params.profileIds,
      beforeRemove,
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
    }))
  ) {
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
