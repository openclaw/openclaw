import { type FastMode, normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";

export async function existingSessionSelectionWouldChange(params: {
  agentId: string;
  cfg: OpenClawConfig;
  catalogModel?: string;
  defaultModel: string;
  defaultProvider: string;
  existingEntry: SessionEntry;
  loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  requestedModel?: string;
  requestedAgentRuntime?: string;
  requestedContextWindow?: string;
  requestedFastMode?: FastMode;
  requestedThinkingLevel?: string;
  subagentModelHint?: string;
}): Promise<boolean> {
  if (params.catalogModel) {
    // Public catalog creates cannot include a key, and the service rejects
    // catalog targets for existing rows. If a trusted caller reaches this,
    // keep catalog-owned model/runtime adoption fail-closed.
    return true;
  }
  if (
    params.requestedAgentRuntime !== undefined &&
    params.requestedAgentRuntime !== params.existingEntry.agentRuntimeOverride
  ) {
    return true;
  }
  const requestedThinkingLevel = normalizeOptionalString(params.requestedThinkingLevel);
  const requestedContextWindow = normalizeOptionalString(params.requestedContextWindow);
  if (
    params.requestedFastMode !== undefined &&
    params.requestedFastMode !== params.existingEntry.fastMode
  ) {
    return true;
  }
  if (
    requestedContextWindow &&
    requestedContextWindow !== normalizeOptionalString(params.existingEntry.contextWindow)
  ) {
    return true;
  }
  if (
    requestedThinkingLevel &&
    requestedThinkingLevel !== normalizeOptionalString(params.existingEntry.thinkingLevel)
  ) {
    return true;
  }
  const requestedModel = normalizeOptionalString(params.requestedModel);
  if (!requestedModel) {
    return false;
  }
  if (!params.loadGatewayModelCatalogSnapshot) {
    // Public/TUI model selection paths provide the catalog loader used by the
    // patch resolver. Without it, an existing-row model request cannot prove
    // it is a no-op, so non-admin callers must not reach the mutation path.
    return true;
  }
  const catalog = await params.loadGatewayModelCatalogSnapshot();
  const resolved = resolveSessionPatchModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: catalog.entries,
    raw: requestedModel,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
    subagentModelHint: params.subagentModelHint,
  });
  if (!resolved.ok) {
    // Admin callers still receive the precise model error from sessions.patch.
    // Non-admin existing-row creates fail closed before that mutation path.
    return true;
  }
  let existingProvider =
    normalizeOptionalString(params.existingEntry.providerOverride) ?? params.defaultProvider;
  let existingModel =
    normalizeOptionalString(params.existingEntry.modelOverride) ?? params.defaultModel;
  if (!normalizeOptionalString(params.existingEntry.modelOverride) && params.subagentModelHint) {
    const resolvedSubagentDefault = resolveSessionPatchModelSelection({
      cfg: params.cfg,
      agentId: params.agentId,
      catalog: catalog.entries,
      raw: params.subagentModelHint,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
    });
    if (!resolvedSubagentDefault.ok) {
      return true;
    }
    if (!normalizeOptionalString(params.existingEntry.providerOverride)) {
      existingProvider = resolvedSubagentDefault.provider;
    }
    existingModel = resolvedSubagentDefault.model;
  }
  const existingProfile = normalizeOptionalString(params.existingEntry.authProfileOverride);
  const requestedProfile = normalizeOptionalString(resolved.profile);
  const profileWouldChange =
    requestedProfile !== undefined
      ? requestedProfile !== existingProfile
      : existingProfile !== undefined &&
        !shouldPreserveSessionAuthProfileOverride({
          cfg: params.cfg,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
          currentProvider:
            params.existingEntry.providerOverride ??
            params.existingEntry.modelProvider ??
            params.defaultProvider,
          entry: params.existingEntry,
          provider: resolved.provider,
        });
  return (
    resolved.provider !== existingProvider || resolved.model !== existingModel || profileWouldChange
  );
}
