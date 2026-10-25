import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { type FastMode, normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { prepareAuthProfileProvider } from "../agents/auth-profiles/store-runtime.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { shouldPreserveSessionAuthProfileOverride } from "../sessions/auth-profile-preservation.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";

/** Project requested settings without turning omitted fields into clearing mutations. */
export function buildSessionCreateSettingsPatch(
  params: Pick<
    CreateGatewaySessionParams,
    | "category"
    | "agentRuntime"
    | "cyberAccessProgram"
    | "toolOverrides"
    | "communication"
    | "permissionMode"
  >,
  selected: {
    key: string;
    label?: string;
    model?: string;
    contextWindow?: string;
    thinkingLevel?: string;
    fastMode?: FastMode;
  },
) {
  // Patch appliers read key presence as caller intent (present = change, null = clear).
  // Omitted model/context/effort fields must stay absent to retain selection state.
  return {
    key: selected.key,
    label: selected.label,
    category: normalizeOptionalString(params.category),
    ...(selected.model ? { model: selected.model } : {}),
    ...(params.agentRuntime !== undefined ? { agentRuntime: params.agentRuntime } : {}),
    ...(selected.contextWindow ? { contextWindow: selected.contextWindow } : {}),
    ...(selected.thinkingLevel ? { thinkingLevel: selected.thinkingLevel } : {}),
    ...(params.cyberAccessProgram !== undefined
      ? { cyberAccessProgram: params.cyberAccessProgram }
      : {}),
    ...(selected.fastMode !== undefined ? { fastMode: selected.fastMode } : {}),
    ...(params.toolOverrides !== undefined ? { toolOverrides: params.toolOverrides } : {}),
    ...(params.communication !== undefined ? { communication: params.communication } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
  };
}

/** Creation can adopt a key, but only an explicit settings mutation can replace its policy. */
export function sessionCreatePolicyAdoptionError(
  existing: SessionEntry | undefined,
  projected: SessionEntry,
  requested: Pick<Partial<SessionEntry>, "toolOverrides" | "communication">,
): string | undefined {
  if (existing) {
    for (const field of ["toolOverrides", "communication"] as const) {
      if (
        requested[field] !== undefined &&
        stableStringify(existing[field]) !== stableStringify(projected[field])
      ) {
        return "sessions.create " + field + " requires a new session";
      }
    }
  }
  return undefined;
}

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
  requestedCyberAccessProgram?: SessionEntry["cyberAccessProgram"] | null;
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
  if (
    params.requestedCyberAccessProgram !== undefined &&
    (params.requestedCyberAccessProgram ?? undefined) !== params.existingEntry.cyberAccessProgram
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
  const selectionPolicy = {
    cfg: params.cfg,
    agentId: params.agentId,
    catalog: catalog.entries,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  };
  const resolved = resolveSessionPatchModelSelection({
    ...selectionPolicy,
    raw: requestedModel,
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
      ...selectionPolicy,
      raw: params.subagentModelHint,
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
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const recordedProvider =
    requestedProfile === undefined && existingProfile
      ? await prepareAuthProfileProvider({ agentDir, profileId: existingProfile })
      : undefined;
  const profileWouldChange =
    requestedProfile !== undefined
      ? requestedProfile !== existingProfile
      : existingProfile !== undefined &&
        !shouldPreserveSessionAuthProfileOverride({
          cfg: params.cfg,
          agentDir,
          recordedProvider,
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
