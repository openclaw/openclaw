/** Command for removing one saved model auth profile. */
import { isDeepStrictEqual } from "node:util";
import {
  type AuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
} from "../../agents/auth-profiles.js";
import { listCandidateAuthProfileStores } from "../../agents/auth-profiles/candidate-stores.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "../../agents/auth-profiles/store.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import { withPluginModelCatalogWriteLocks } from "../../agents/plugin-model-catalog-lock.js";
import { removePersistedPluginModelCatalogCredentials } from "../../agents/plugin-model-catalog.js";
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

// A provider entry can name an auth profile as its `apiKey`. Removing such a
// profile would leave that config key pointing at nothing and silently degrade
// the provider to an unresolvable literal key, so refuse instead.
function findProviderEntryBoundToProfile(params: {
  cfg: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
}): string | undefined {
  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg: params.cfg,
      provider,
      store: params.store,
    });
    if (
      (reference.kind === "profile" || reference.kind === "profile-incompatible") &&
      reference.profileId === params.profileId
    ) {
      return provider;
    }
  }
  return undefined;
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
  const credential = store.profiles[profileId]
    ? structuredClone(store.profiles[profileId])
    : undefined;
  if (!credential) {
    throw new Error(
      `Auth profile "${profileId}" not found for agent "${agentId}". Run ${formatCliCommand(`openclaw models auth list --agent ${agentId}`)} to see saved profile ids.`,
    );
  }

  const boundProvider = findProviderEntryBoundToProfile({ cfg, store, profileId });
  if (boundProvider) {
    throw new Error(
      `Auth profile "${profileId}" is referenced by models.providers.${boundProvider}.apiKey. Change that config value first, then rerun ${formatCliCommand(`openclaw models auth logout ${profileId}`)}.`,
    );
  }

  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId });
  const ownerCredential = structuredClone(
    ensureAuthProfileStoreWithoutExternalProfiles(ownerAgentDir).profiles[profileId],
  );
  if (!ownerCredential) {
    throw new Error("The selected auth profile changed during logout. Review it and retry.");
  }
  const assertSelection = () => {
    if (
      !isDeepStrictEqual(
        ensureAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId],
        credential,
      ) ||
      resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId }) !== ownerAgentDir ||
      !isDeepStrictEqual(
        ensureAuthProfileStoreWithoutExternalProfiles(ownerAgentDir).profiles[profileId],
        ownerCredential,
      )
    ) {
      throw new Error("The selected auth profile changed during logout. Review it and retry.");
    }
  };
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

  const catalogAgentDirs = new Set(
    (await listCandidateAuthProfileStores({ cfg })).map((candidate) => candidate.agentDir),
  );
  catalogAgentDirs.add(agentDir);

  const invalidatedCatalogEntries = await withPluginModelCatalogWriteLocks(
    [...catalogAgentDirs],
    async () => {
      assertSelection();
      // Keep config-before-deletion retryability without changing a replacement
      // profile's routing while confirmation or catalog admission was pending.
      if (configReferencesAuthProfile(cfg, profileId)) {
        await updateConfig((current) => {
          assertSelection();
          return removeAuthProfileConfig(current, profileId);
        });
        logConfigUpdated(runtime);
      }
      assertSelection();
      const profileReferenceAgentDirs = [...catalogAgentDirs].filter(
        (candidateDir) =>
          resolvePersistedAuthProfileOwnerAgentDir({ agentDir: candidateDir, profileId }) ===
          ownerAgentDir,
      );
      const retiredCredentials = [credential, ownerCredential];
      for (const candidateDir of profileReferenceAgentDirs) {
        const copy =
          ensureAuthProfileStoreWithoutExternalProfiles(candidateDir).profiles[profileId];
        if (copy && !retiredCredentials.some((retired) => isDeepStrictEqual(retired, copy))) {
          retiredCredentials.push(structuredClone(copy));
        }
      }
      // Remove only the selected credential's generated copies. Survivor inventory
      // and credentials owned by other agents do not become a provider-wide ban.
      let changed = 0;
      for (const retired of retiredCredentials.filter(
        (value, index) =>
          retiredCredentials.findIndex((other) => isDeepStrictEqual(other, value)) === index,
      )) {
        changed += removePersistedPluginModelCatalogCredentials({
          agentDirs: [...catalogAgentDirs],
          credential: retired,
          profileId,
          profileReferenceAgentDirs,
          lockAlreadyHeld: true,
        });
      }
      const removed = await removeAuthProfilesAcrossOwnerStores({
        cfg,
        agentDir,
        profileIds: [profileId],
        expectedSelection: { profileId, credential, ownerCredential, ownerAgentDir },
      });
      if (!removed) {
        throw new Error(
          `Failed to remove auth profile "${profileId}"; the auth store lock may be busy. Wait a moment and retry.`,
        );
      }
      return changed;
    },
  );

  await refreshRunningGatewayAuthState(agentId, "logout", runtime);
  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Removed auth profile: ${description}`);
  if (invalidatedCatalogEntries > 0) {
    runtime.log(
      `Removed retired authentication from ${invalidatedCatalogEntries} cached model catalog entr${invalidatedCatalogEntries === 1 ? "y" : "ies"}.`,
    );
  }
  const remaining = listProfilesForProvider(store, credential.provider).filter(
    (id) => id !== profileId,
  );
  if (remaining.length === 0) {
    runtime.log(
      `No auth profiles remain for ${credential.provider}. Run ${formatCliCommand(`openclaw models auth login --provider ${credential.provider}`)} to sign in again.`,
    );
  }
}
