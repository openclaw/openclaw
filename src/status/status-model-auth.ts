import { resolveAuthProfileDisplayLabel } from "../agents/auth-profiles.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import { createModelCatalogDecisions } from "../agents/model-catalog-decisions.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { getPreparedModelRuntimeAuthStore } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";

/** Native status uses the same prepared account and route as model selection. */
export function createStatusModelAuthResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionEntry?: SessionEntry;
  owner?: PreparedModelRuntimeSnapshot;
}) {
  const { owner, sessionEntry } = params;
  const authStore = owner && getPreparedModelRuntimeAuthStore(owner);
  const decisions =
    owner && authStore
      ? createModelCatalogDecisions({
          cfg: owner.config,
          agentId: params.agentId,
          agentDir: owner.agentDir,
          workspaceDir: owner.workspaceDir,
          snapshot: owner.modelCatalog,
          metadataSnapshot: owner.metadataSnapshot,
          preparedAuthStore: authStore,
          preparedRuntimeAuthModes: owner.authModes,
          pluginRegistry: owner.pluginRegistry,
          observationConfig: owner.observationConfig,
          isCurrent: owner.isCurrent,
          preferredProfileId: sessionEntry?.authProfileOverride,
          pinnedProfileId:
            sessionEntry?.authProfileOverrideSource === "user"
              ? sessionEntry.authProfileOverride
              : undefined,
          profileProvider: sessionEntry?.providerOverride ?? sessionEntry?.modelProvider,
        })
      : undefined;
  return async (selection: {
    provider: string;
    model: string;
    runtimeId?: string;
    acceptedProviderIds: readonly string[];
  }): Promise<string | undefined> => {
    const { provider, model, runtimeId } = selection;
    // SDK renderers without a prepared owner retain host-profile diagnostics.
    // A native observation, when present, never falls back to a different account.
    if (
      !owner ||
      !runtimeId ||
      runtimeId === "openclaw" ||
      runtimeId === "auto" ||
      provider === runtimeId
    ) {
      return resolveModelAuthLabel({
        provider,
        acceptedProviderIds: selection.acceptedProviderIds,
        cfg: params.cfg,
        sessionEntry,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        includeExternalProfiles: false,
      });
    }
    if (!decisions?.isCurrent() || !authStore) {
      return "unknown";
    }
    const entry = findModelInCatalog(decisions.snapshot.entries, provider, model);
    const variants = decisions.snapshot.routeVariants.filter(
      (row) => row.provider === provider && row.id === model,
    );
    const host = await decisions.evaluateEntry(
      entry ?? { provider, id: model },
      variants.length ? variants : entry ? [entry] : undefined,
      runtimeId,
    );
    const evaluation = entry ? decisions.evaluateNative(entry, host, runtimeId) : host;
    if (!decisions.isCurrent() || evaluation.availability !== true) {
      return "unknown";
    }
    if (evaluation.runtimeAuth && evaluation.runtimeAuth.id !== runtimeId) {
      return "unknown";
    }
    const mode =
      evaluation.selectedAuthMode === "api_key" ? "api-key" : evaluation.selectedAuthMode;
    const profileId = evaluation.selectedProfileId;
    if (profileId) {
      const label = isUserModelAuthProfileId(profileId)
        ? "personal account"
        : resolveAuthProfileDisplayLabel({ cfg: params.cfg, store: authStore, profileId });
      return mode ? mode + (label ? " (" + label + ")" : "") : "unknown";
    }
    return evaluation.runtimeAuth
      ? (mode ?? "native") + " (" + runtimeId + ")"
      : (mode ?? "unknown");
  };
}
