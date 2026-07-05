import {
  loadAuthProfileStoreWithoutExternalProfiles,
  removeAuthProfilesWithLock,
  resolveAuthProfileDisplayLabel,
  resolvePersistedAuthProfileOwnerAgentDir,
  resolveAuthStatePathForDisplay,
  type AuthProfileCredential,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import { resolveAuthStorePath } from "../../agents/auth-profiles/paths.js";
/** Command helper for removing saved model auth profiles. */
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { promptYesNo } from "../../cli/prompt.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

type RemovedAuthProfileSummary = {
  id: string;
  provider: string;
  type: AuthProfileCredential["type"];
  label: string;
};

function summarizeProfile(params: {
  cfg: Awaited<ReturnType<typeof loadModelsConfig>>;
  store: AuthProfileStore;
  profileId: string;
  profile: AuthProfileCredential;
}): RemovedAuthProfileSummary {
  return {
    id: params.profileId,
    provider: resolveProviderIdForAuth(params.profile.provider),
    type: params.profile.type,
    label: resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store: params.store,
      profileId: params.profileId,
    }),
  };
}

function listProfilesForAuthProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, profile]) => resolveProviderIdForAuth(profile.provider) === providerKey)
    .map(([profileId]) => profileId)
    .toSorted((a, b) => a.localeCompare(b));
}

function resolveProfilesToRemove(params: {
  profileId?: string;
  provider?: string;
  all?: boolean;
  store: AuthProfileStore;
}): string[] {
  const profileId = params.profileId?.trim();
  const provider = params.provider?.trim();

  if (profileId) {
    if (params.all) {
      throw new Error("Pass either <profileId> or --all, not both.");
    }
    if (!params.store.profiles[profileId]) {
      throw new Error(
        `Auth profile "${profileId}" not found. Run ${formatCliCommand("openclaw models auth list")} to see saved profiles.`,
      );
    }
    if (
      provider &&
      resolveProviderIdForAuth(params.store.profiles[profileId].provider) !==
        resolveProviderIdForAuth(provider)
    ) {
      throw new Error(`Auth profile "${profileId}" is not for provider ${provider}.`);
    }
    return [profileId];
  }

  if (!provider) {
    throw new Error(
      `Missing auth profile id. Run ${formatCliCommand("openclaw models auth list")} to choose a profile.`,
    );
  }

  const profileIds = listProfilesForAuthProvider(params.store, provider);
  if (!params.all) {
    const suffix =
      profileIds.length > 0
        ? ` Saved profiles: ${profileIds.join(", ")}.`
        : " No saved profiles matched this provider.";
    throw new Error(
      `Refusing to remove all ${resolveProviderIdForAuth(provider)} auth profiles without --all.${suffix}`,
    );
  }
  if (profileIds.length === 0) {
    throw new Error(
      `No saved auth profiles found for provider ${resolveProviderIdForAuth(provider)}.`,
    );
  }
  return profileIds;
}

function assertProfilesOwnedBySelectedAgent(params: {
  agentDir: string;
  profileIds: readonly string[];
}): void {
  const selectedAuthStorePath = resolveAuthStorePath(params.agentDir);
  const mainAuthStorePath = resolveAuthStorePath();
  for (const profileId of params.profileIds) {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: params.agentDir,
      profileId,
    });
    if (ownerAgentDir === params.agentDir) {
      continue;
    }
    if (!ownerAgentDir && selectedAuthStorePath === mainAuthStorePath) {
      continue;
    }
    const ownerAgentLabel = ownerAgentDir ? "another agent" : "the main auth store";
    throw new Error(
      `Auth profile "${profileId}" is inherited from ${ownerAgentLabel}; remove it from the owning agent store instead.`,
    );
  }
}

async function confirmRemoval(params: {
  profileIds: readonly string[];
  dryRun?: boolean;
  yes?: boolean;
}): Promise<void> {
  if (params.dryRun || params.yes) {
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error("Non-interactive auth profile removal requires --yes.");
  }
  const ok = await promptYesNo(
    `Remove ${params.profileIds.length} auth profile(s): ${params.profileIds.join(", ")}?`,
    false,
  );
  if (!ok) {
    throw new Error("Cancelled auth profile removal.");
  }
}

export async function modelsAuthRemoveCommand(
  opts: {
    profileId?: string;
    provider?: string;
    all?: boolean;
    agent?: string;
    dryRun?: boolean;
    yes?: boolean;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const cfg = await loadModelsConfig({ commandName: "models auth remove", runtime });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent);
  const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const profileIds = resolveProfilesToRemove({
    profileId: opts.profileId,
    provider: opts.provider,
    all: opts.all,
    store,
  });
  assertProfilesOwnedBySelectedAgent({
    agentDir,
    profileIds,
  });
  const profiles = profileIds.map((profileId) =>
    summarizeProfile({
      cfg,
      store,
      profileId,
      profile: store.profiles[profileId],
    }),
  );

  await confirmRemoval({ profileIds, dryRun: opts.dryRun, yes: opts.yes });

  if (!opts.dryRun) {
    const updated = await removeAuthProfilesWithLock({ agentDir, profileIds });
    if (!updated) {
      throw new Error(
        `Failed to update auth profiles; the auth state lock may be busy. Wait a moment and rerun ${formatCliCommand("openclaw models auth remove <profileId> --yes")}.`,
      );
    }
  }

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      agentDir: shortenHomePath(agentDir),
      authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
      dryRun: Boolean(opts.dryRun),
      removed: opts.dryRun ? [] : profiles,
      wouldRemove: opts.dryRun ? profiles : [],
    });
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  runtime.log(opts.dryRun ? "Would remove auth profiles:" : "Removed auth profiles:");
  for (const profile of profiles) {
    runtime.log(`- ${profile.label} [${profile.provider}/${profile.type}]`);
  }
}
