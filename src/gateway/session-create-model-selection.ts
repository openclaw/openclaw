import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { resolveModelProviderAuthConfig } from "../agents/model-auth-provider-route.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import { findModelCatalogEntry } from "../agents/model-catalog.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveDefaultModelForAgent, type ModelRef } from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import { isUserModelAuthProfileOwner } from "../state/user-model-accounts.js";
import type { ModelAccountConnectAction } from "./model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "./model-account-connect.js";
import {
  prepareSessionPatchModelSelection,
  resolveSessionPatchModelSelection,
} from "./server-methods/sessions-patch-model-selection.js";
import type { GatewaySessionTitleModelSelection } from "./session-lifecycle-preparation.js";

const loadSessionAuthRuntime = createLazyRuntimeModule(
  () => import("../agents/auth-profiles/session-override.js"),
);

export function prepareSessionCreateModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  input: string | { model: string; agentRuntime?: string } | undefined;
  parentEntry?: SessionEntry;
  preparedModelSelection?: ModelRef;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}):
  | {
      ok: true;
      selection: GatewaySessionTitleModelSelection | null;
      validate?: () => ErrorShape | undefined;
    }
  | { ok: false; error: ErrorShape } {
  const { cfg, agentId, input, parentEntry, preparedModelSelection, operatorAuthority } = params;
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  if (!model) {
    const inherited = inheritSessionSelection(parentEntry);
    return {
      ok: true,
      selection: {
        providerOverride: inherited.providerOverride,
        modelOverride: inherited.modelOverride,
        agentRuntimeOverride: inherited.agentRuntimeOverride,
        authProfileOverride: inherited.authProfileOverride,
      },
    };
  }
  const defaults = resolveDefaultModelForAgent({ cfg, agentId });
  // Reuse patch policy with the config-owned catalog projection. Persisted creation
  // remains the sole live-catalog availability validator.
  const resolved = resolveSessionPatchModelSelection({
    cfg,
    agentId,
    catalog: [],
    raw: model,
    defaultProvider: defaults.provider,
    defaultModel: defaults.model,
    preparedModelSelection,
  });
  if (!resolved.ok) {
    return { ok: true, selection: null };
  }
  const prepared = prepareSessionPatchModelSelection({
    cfg,
    agentId,
    selection: resolved,
    resetToDefault: false,
    operatorAuthority,
  });
  if (!prepared.ok) {
    return prepared;
  }
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(
    typeof input === "string" ? undefined : input?.agentRuntime,
  );
  return {
    ok: true,
    validate: prepared.validate,
    selection: {
      providerOverride: resolved.provider,
      modelOverride: resolved.model,
      ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
      ...(resolved.profile ? { authProfileOverride: resolved.profile } : {}),
    },
  };
}

/** Title preparation and the row commit retain the same caller, model, and account fences. */
export function createSessionCreateCommitGuard(params: {
  assertCallerCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  selections: readonly ({ assertCurrent: () => void } | undefined)[];
  personalAccountDefaults?: ModelAccountConnectAction;
  readDefaultProfile: () => string | undefined;
  validateSelection: () => ErrorShape | undefined;
}): () => void {
  return () => {
    params.assertCallerCurrent?.();
    params.operatorAuthority?.assertCurrent();
    const error = params.validateSelection();
    if (error) {
      throw new Error(error.message);
    }
    for (const selection of params.selections) {
      selection?.assertCurrent();
    }
    const selectedProfile = params.readDefaultProfile();
    if (
      params.personalAccountDefaults &&
      selectedProfile &&
      isUserModelAuthProfileId(selectedProfile) &&
      !isUserModelAuthProfileOwner({
        profileId: params.personalAccountDefaults.owner,
        authProfileId: selectedProfile,
      })
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
}

/** New unpinned sessions bind an account for the caller's permitted default without storing a model pin. */
export async function prepareSessionCreateDefaultAccount(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entry: SessionEntry;
  defaults: ModelAccountConnectAction;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  resetToDefault: boolean;
  assertCurrent?: () => void;
}): Promise<
  | { ok: true; profileId?: string; validate: () => ErrorShape | undefined }
  | { ok: false; error: ErrorShape }
> {
  const { resolveUserLinkedAuthProfile } = await loadSessionAuthRuntime();
  params.assertCurrent?.();
  params.defaults.assertCurrent();
  const selected = prepareSessionPatchModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    selection: {
      ...resolveSessionModelRef(params.cfg, params.entry, params.agentId),
      isDefault: params.resetToDefault,
    },
    resetToDefault: params.resetToDefault,
    operatorAuthority: params.operatorAuthority,
  });
  if (!selected.ok) {
    return selected;
  }
  const model = selected.selection;
  const linked = resolveUserLinkedAuthProfile({
    cfg: resolveModelProviderAuthConfig({
      config: params.cfg,
      provider: model.provider,
      modelId: model.model,
    }),
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    provider: model.provider,
    requesterProfileId: params.defaults.owner,
  });
  return { ok: true, profileId: linked?.profileId, validate: selected.validate };
}

/** Catalog-owned creations cannot mix independent model or key selections. */
export function resolveSessionCreateCatalogSelectionError(
  params: Pick<SessionsCreateParams, "catalogId" | "model" | "agentRuntime" | "key">,
): ErrorShape | undefined {
  const catalogId = normalizeOptionalString(params.catalogId);
  const conflict = params.model
    ? "model"
    : params.agentRuntime
      ? "agentRuntime"
      : params.key
        ? "key"
        : undefined;
  return catalogId && conflict
    ? errorShape(ErrorCodes.INVALID_REQUEST, `sessions.create catalogId cannot include ${conflict}`)
    : undefined;
}

export async function resolveSessionForkMaxTokens(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
}): Promise<number | undefined> {
  const childModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const childCatalog = params.loadGatewayModelCatalogSnapshot
    ? await params.loadGatewayModelCatalogSnapshot()
    : undefined;
  const childLogicalEntry = findModelCatalogEntry(childCatalog?.entries ?? [], {
    provider: childModel.provider,
    modelId: childModel.model,
  });
  const childCatalogEntry =
    childLogicalEntry && childCatalog
      ? selectModelCatalogRuntimeEntry({
          entry: childLogicalEntry,
          routeVariants: childCatalog.routeVariants,
          runtimeId: resolveEffectiveAgentRuntime({
            cfg: params.cfg,
            agentId: params.agentId,
            provider: childModel.provider,
            modelId: childModel.model,
            sessionKey: params.sessionKey,
            sessionEntry: params.entry,
          }),
        }).entry
      : undefined;
  const childContextWindow = resolveModelContextWindowProfile({
    catalogEntry: childCatalogEntry,
    selected: params.entry.contextWindow,
  });
  const resolvedForkMaxTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: childModel.provider,
    model: childModel.model,
    modelContextTokens: childCatalogEntry?.contextTokens,
    modelContextWindow: childContextWindow.contextTokens,
    allowAsyncLoad: false,
    allowUnscopedModelLookup: false,
  });
  return childContextWindow.contextTokens
    ? Math.min(
        resolvedForkMaxTokens ?? childContextWindow.contextTokens,
        childContextWindow.contextTokens,
      )
    : resolvedForkMaxTokens;
}
