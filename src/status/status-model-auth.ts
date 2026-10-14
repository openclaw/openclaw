import { resolveAuthProfileDisplayLabel } from "../agents/auth-profiles.js";
import { resolveModelAuthLabelAsync } from "../agents/model-auth-label.js";
import { prepareModelCatalogDecisions } from "../agents/model-catalog-decisions.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { getPreparedModelRuntimeAuthStore } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { formatModelEndpointUrl } from "./status-model-endpoint.js";

type StatusModelResolution = { authLabel?: string; endpoint?: string };

/** Status borrows the account and route selected by the prepared model owner. */
export function createStatusModelResolver(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  sessionEntry?: SessionEntry;
  owner?: PreparedModelRuntimeSnapshot;
}) {
  const { owner, sessionEntry } = params;
  const authStore = owner && getPreparedModelRuntimeAuthStore(owner);
  const preparation =
    owner && authStore
      ? prepareModelCatalogDecisions({
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
    authLabelOverride?: string;
  }): Promise<StatusModelResolution> => {
    const decisions = await preparation;
    const { provider, model, runtimeId } = selection;
    // Preserve SDK and built-in auth diagnostics; route display only borrows an
    // existing prepared owner and never starts discovery or resolves credentials.
    const usesHostAuth =
      !owner ||
      !runtimeId ||
      runtimeId === "openclaw" ||
      runtimeId === "auto" ||
      provider === runtimeId;
    const hasAuthOverride = Object.hasOwn(selection, "authLabelOverride");
    const authLabel = hasAuthOverride
      ? selection.authLabelOverride
      : usesHostAuth
        ? await resolveModelAuthLabelAsync({
            provider,
            acceptedProviderIds: selection.acceptedProviderIds,
            cfg: params.cfg,
            sessionEntry,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
            includeExternalProfiles: false,
            authStore,
          })
        : "unknown";
    if (!decisions?.isCurrent() || !authStore) {
      return { authLabel };
    }
    const entry = findModelInCatalog(decisions.snapshot.entries, provider, model);
    const variants = decisions.snapshot.routeVariants.filter(
      (row) => row.provider === provider && row.id === model,
    );
    const host = decisions.evaluateEntry(
      entry ?? { provider, id: model },
      variants.length ? variants : entry ? [entry] : undefined,
      runtimeId,
    );
    const evaluation = entry ? decisions.evaluateNative(entry, host, runtimeId) : host;
    if (!decisions.isCurrent() || evaluation.availability !== true) {
      return { authLabel };
    }
    if (evaluation.runtimeAuth && evaluation.runtimeAuth.id !== runtimeId) {
      return { authLabel };
    }
    const endpoint = evaluation.selectedRoute?.baseUrl
      ? formatModelEndpointUrl(evaluation.selectedRoute.baseUrl)
      : undefined;
    // Prepared auth remains authoritative without a route; provider-wide labels
    // can prefer another stored credential over an explicitly configured key.
    if (hasAuthOverride || (usesHostAuth && !evaluation.selectedCredential)) {
      return { authLabel, endpoint };
    }
    const mode =
      evaluation.selectedAuthMode === "api_key" ? "api-key" : evaluation.selectedAuthMode;
    const profileId = evaluation.selectedProfileId;
    const label = profileId
      ? isUserModelAuthProfileId(profileId)
        ? "personal account"
        : resolveAuthProfileDisplayLabel({ cfg: params.cfg, store: authStore, profileId })
      : evaluation.runtimeAuth
        ? runtimeId
        : evaluation.evidence === "provider-config"
          ? "models.json"
          : evaluation.evidence === "environment"
            ? "environment"
            : undefined;
    return {
      authLabel:
        (mode ?? (evaluation.runtimeAuth ? "native" : "unknown")) + (label ? ` (${label})` : ""),
      endpoint,
    };
  };
}
