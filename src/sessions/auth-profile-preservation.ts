import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { prepareAuthProfileProvider } from "../agents/auth-profiles.runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { resolvePreparedProviderIdForAuth as resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

type SessionAuthProfilePreservationParams = {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  /** Presence records completed preparation, including authoritative credential absence. */
  recordedProvider: { provider: string | undefined };
};

/** Checks whether a pinned session auth profile can authenticate the selected provider. */
export function shouldPreserveSessionAuthProfileOverride(
  params: SessionAuthProfilePreservationParams,
): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!profileOverride || !provider) {
    return false;
  }
  const resolvesToTargetProvider = (
    rawProvider: string | undefined,
    storedCredential = false,
  ): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    const lookupParams = {
      config: params.cfg,
      ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    };
    return Boolean(
      candidate &&
      resolveProviderIdForAuth(candidate, { ...lookupParams, storedCredential }) ===
        resolveProviderIdForAuth(provider, lookupParams),
    );
  };
  const recordedProvider =
    params.recordedProvider.provider ?? params.cfg.auth?.profiles?.[profileOverride]?.provider;
  if (recordedProvider) {
    return resolvesToTargetProvider(recordedProvider, true);
  }
  const delimiterIndex = profileOverride.indexOf(":");
  // Missing personal IDs carry no provider; admission must report the unavailable account, not replace it.
  if (delimiterIndex < 0 || isUserModelAuthProfileId(profileOverride)) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  return resolvesToTargetProvider(profileOverride.slice(0, delimiterIndex), true);
}

/** Missing credentials preserve explicit same-provider intent until authentication reports recovery. */
export function shouldPreserveUnavailableSessionAuthProfileOverride(
  params: Omit<SessionAuthProfilePreservationParams, "recordedProvider"> & {
    store: Pick<AuthProfileStore, "profiles">;
    recordedProvider?: SessionAuthProfilePreservationParams["recordedProvider"];
  },
): boolean {
  const profileId = normalizeOptionalString(params.entry.authProfileOverride);
  return Boolean(
    profileId &&
    !params.store.profiles[profileId] &&
    resolveCollapsedSessionAuthPinSource(params.entry) === "user" &&
    shouldPreserveSessionAuthProfileOverride({
      ...params,
      recordedProvider: params.recordedProvider ?? { provider: undefined },
    }),
  );
}

/** Applies a user model selection without dropping a compatible pinned auth profile. */
export function applyModelOverrideWithAuthProfileCompatibilityCore(
  params: Omit<SessionAuthProfilePreservationParams, "provider"> &
    Omit<Parameters<typeof applyModelOverrideToSessionEntry>[0], "preserveAuthProfileOverride">,
): { updated: boolean } {
  return applyModelOverrideToSessionEntry({
    entry: params.entry,
    selection: params.selection,
    profileOverride: params.profileOverride,
    profileOverrideSource: params.profileOverrideSource || undefined,
    selectionSource: params.selectionSource || undefined,
    explicitDefaultSelection: params.explicitDefaultSelection,
    markLiveSwitchPending: params.markLiveSwitchPending,
    preserveAuthProfileOverride:
      !params.profileOverride &&
      shouldPreserveSessionAuthProfileOverride({
        cfg: resolveModelProviderAuthConfig({
          config: params.cfg,
          provider: params.selection.provider,
          modelId: params.selection.model,
          metadataSnapshot: params.metadataSnapshot,
        }),
        agentDir: params.agentDir,
        entry: params.entry,
        currentProvider: params.currentProvider,
        provider: params.selection.provider,
        recordedProvider: params.recordedProvider,
        ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
      }),
  });
}

/** Prepare the pinned account through its owner before changing the session selection. */
export async function applyModelOverrideWithAuthProfileCompatibilityAsync(
  params: Omit<
    Parameters<typeof applyModelOverrideWithAuthProfileCompatibilityCore>[0],
    "recordedProvider"
  > & { recordedProvider?: SessionAuthProfilePreservationParams["recordedProvider"] },
): Promise<{ updated: boolean }> {
  let metadataSnapshot = params.metadataSnapshot;
  if (!metadataSnapshot) {
    const { resolvePluginMetadataSnapshotAsync } =
      await import("../plugins/plugin-metadata-snapshot.js");
    metadataSnapshot = await resolvePluginMetadataSnapshotAsync({
      config: params.cfg,
      allowWorkspaceScopedCurrent: true,
    });
  }
  const profileId = normalizeOptionalString(params.entry.authProfileOverride);
  const recordedProvider =
    params.recordedProvider ??
    (profileId && !params.profileOverride
      ? await prepareAuthProfileProvider({ agentDir: params.agentDir, profileId })
      : { provider: undefined });
  return applyModelOverrideWithAuthProfileCompatibilityCore({
    ...params,
    metadataSnapshot,
    recordedProvider,
  });
}
