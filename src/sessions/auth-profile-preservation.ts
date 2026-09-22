import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAuthProfileProviderForSelection } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};

type SessionAuthProfilePreservationParams = {
  cfg: OpenClawConfig;
  agentDir?: string;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
};

type PreparedSessionAuthProfileProvider = { profileId: string; provider: string | undefined };

/** Prepare missing user intent before selection, never from a synchronous session writer. */
export function prepareUnavailableSessionAuthProfileOverride(params: {
  agentDir?: string;
  entry: SessionEntry;
  store: Pick<AuthProfileStore, "profiles">;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
}): Promise<PreparedSessionAuthProfileProvider> | undefined {
  const profileId = normalizeOptionalString(params.entry.authProfileOverride);
  if (
    !profileId ||
    params.store.profiles[profileId] ||
    resolveCollapsedSessionAuthPinSource(params.entry) !== "user"
  ) {
    return undefined;
  }
  const captureSelection = (entry: SessionEntry | undefined) => [
    entry?.sessionId,
    entry?.authProfileOverride,
    entry?.authProfileOverrideSource,
    entry?.authProfileOverrideCompactionCount,
  ];
  const selection = captureSelection(params.entry);
  const storeEntry = params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined;
  const storeSelection = captureSelection(storeEntry);
  return (async () => {
    const { prepareAuthProfileProviderForSelection } =
      await import("../agents/auth-profiles/store-runtime.js");
    const prepared = await prepareAuthProfileProviderForSelection({
      agentDir: params.agentDir,
      profileId,
    });
    // Async owner reads cannot authorize clearing a newer session or explicit selection.
    if (
      captureSelection(params.entry).some((value, index) => value !== selection[index]) ||
      captureSelection(storeEntry).some((value, index) => value !== storeSelection[index]) ||
      (params.sessionKey && params.sessionStore?.[params.sessionKey] !== storeEntry)
    ) {
      throw new Error("Session auth profile changed during provider preparation; retry selection");
    }
    return prepared;
  })();
}

/** Checks whether a pinned session auth profile can authenticate the selected provider. */
export function shouldPreserveSessionAuthProfileOverride(
  params: SessionAuthProfilePreservationParams,
): boolean {
  const profileId = normalizeOptionalString(params.entry.authProfileOverride);
  // Public synchronous SDK/updater callers keep their existing owner-read contract.
  if (!profileId || !normalizeOptionalLowercaseString(params.provider)) {
    return false;
  }
  return shouldPreserveSessionAuthProfileOverrideWithProvider(
    params,
    resolveAuthProfileProviderForSelection({ agentDir: params.agentDir, profileId }),
  );
}

function shouldPreserveSessionAuthProfileOverrideWithProvider(
  params: SessionAuthProfilePreservationParams,
  profileProvider: string | undefined,
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
    profileProvider ?? params.cfg.auth?.profiles?.[profileOverride]?.provider;
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
  params: SessionAuthProfilePreservationParams & {
    store: Pick<AuthProfileStore, "profiles">;
    preparedProfile: PreparedSessionAuthProfileProvider;
  },
): boolean {
  const profileId = normalizeOptionalString(params.entry.authProfileOverride);
  // A concurrent explicit selection must never be cleared using the previous pin's provider.
  if (profileId !== params.preparedProfile.profileId) {
    throw new Error("Session auth profile changed during provider preparation; retry selection");
  }
  return Boolean(
    profileId &&
    !params.store.profiles[profileId] &&
    resolveCollapsedSessionAuthPinSource(params.entry) === "user" &&
    shouldPreserveSessionAuthProfileOverrideWithProvider(params, params.preparedProfile.provider),
  );
}

/** Applies a user model selection without dropping a compatible pinned auth profile. */
export function applyModelOverrideWithAuthProfileCompatibility(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  entry: SessionEntry;
  currentProvider: string;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  selectionSource?: "auto" | "user";
  explicitDefaultSelection?: boolean;
  markLiveSwitchPending?: boolean;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): { updated: boolean } {
  return applyModelOverrideToSessionEntry({
    entry: params.entry,
    selection: params.selection,
    ...(params.profileOverride ? { profileOverride: params.profileOverride } : {}),
    ...(params.profileOverrideSource
      ? { profileOverrideSource: params.profileOverrideSource }
      : {}),
    ...(params.selectionSource ? { selectionSource: params.selectionSource } : {}),
    ...(params.explicitDefaultSelection
      ? { explicitDefaultSelection: params.explicitDefaultSelection }
      : {}),
    ...(params.markLiveSwitchPending !== undefined
      ? { markLiveSwitchPending: params.markLiveSwitchPending }
      : {}),
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
        ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
      }),
  });
}
