import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../packages/gateway-protocol/src/index.js";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { resolveDefaultModelForAgent, type ModelRef } from "../agents/model-selection.js";
import { inheritSessionSelection } from "../config/sessions/session-entry-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionPatchModelSelection } from "./server-methods/sessions-patch-model-selection.js";
import type { GatewaySessionTitleModelSelection } from "./session-lifecycle-preparation.js";

export function resolveSessionCreateModelSelection(
  cfg: OpenClawConfig,
  agentId: string,
  input: string | { model: string; agentRuntime?: string } | undefined,
  parentEntry?: SessionEntry,
  preparedModelSelection?: ModelRef,
): GatewaySessionTitleModelSelection | null {
  const model = normalizeOptionalString(typeof input === "string" ? input : input?.model);
  if (!model) {
    const inherited = inheritSessionSelection(parentEntry);
    return {
      providerOverride: inherited.providerOverride,
      modelOverride: inherited.modelOverride,
      agentRuntimeOverride: inherited.agentRuntimeOverride,
      authProfileOverride: inherited.authProfileOverride,
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
    return null;
  }
  const agentRuntimeOverride = normalizeOptionalAgentRuntimeId(
    typeof input === "string" ? undefined : input?.agentRuntime,
  );
  return {
    providerOverride: resolved.provider,
    modelOverride: resolved.model,
    ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
    ...(resolved.profile ? { authProfileOverride: resolved.profile } : {}),
  };
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
