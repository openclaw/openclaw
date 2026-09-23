// Shared plugin model authorization; selection, credentials and execution stay with callers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { modelKey } from "../../shared/model-key.js";
import { normalizePluginsConfig } from "../config-state.js";
import { compileModelAllowlist, type CompiledModelAllowlist } from "../model-allowlist.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";
import type { LlmCompleteCaller } from "./types-core.js";

export type RuntimeLlmAuthority = {
  caller?: LlmCompleteCaller;
  /** Trusted host-derived plugin id used only for config policy lookup. */
  pluginIdForPolicy?: string;
  sessionKey?: string;
  agentId?: string;
  preferredProfile?: string;
  requiresBoundAgent?: boolean;
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowedModels?: readonly string[];
  allowedCompletionModels?: readonly string[];
  allowAuthProfileOverride?: boolean;
  allowComplete?: boolean;
  denyReason?: string;
};

type RuntimeLlmPolicy = {
  allowAgentIdOverride: boolean;
  allowModelOverride: boolean;
  allowAuthProfileOverride: boolean;
  overrideModels: CompiledModelAllowlist;
  completionModels: CompiledModelAllowlist;
};

function normalizeCaller(
  caller?: LlmCompleteCaller,
  fallback?: LlmCompleteCaller,
): LlmCompleteCaller {
  const source = caller ?? fallback;
  if (!source) {
    return { kind: "unknown" };
  }
  return {
    kind: source.kind,
    ...(normalizeOptionalString(source.id) ? { id: source.id!.trim() } : {}),
    ...(normalizeOptionalString(source.name) ? { name: source.name!.trim() } : {}),
  };
}

export function resolveTrustedCaller(authority?: RuntimeLlmAuthority): LlmCompleteCaller {
  if (authority?.caller?.kind === "context-engine") {
    return normalizeCaller(authority.caller);
  }
  const scope = getPluginRuntimeGatewayRequestScope();
  const scopedPluginId = normalizeOptionalString(scope?.pluginId);
  if (scopedPluginId) {
    return { kind: "plugin", id: scopedPluginId };
  }
  return normalizeCaller(authority?.caller);
}

/** Authorize explicit selection without choosing a caller-specific default agent. */
export function resolveRequestedRuntimeAgentId(params: {
  agentId?: string;
  authority?: RuntimeLlmAuthority;
  allowAgentIdOverride: boolean;
}): string | undefined {
  const authorityAgentIdRaw = normalizeOptionalString(params.authority?.agentId);
  const requestedAgentIdRaw = normalizeOptionalString(params.agentId);
  const authorityAgentId = authorityAgentIdRaw ? normalizeAgentId(authorityAgentIdRaw) : undefined;
  const requestedAgentId = requestedAgentIdRaw ? normalizeAgentId(requestedAgentIdRaw) : undefined;
  if (params.authority?.requiresBoundAgent && !authorityAgentId) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion is not bound to an active session agent.",
    );
  }
  if (authorityAgentId) {
    if (requestedAgentId && requestedAgentId !== authorityAgentId && !params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the active session agent.",
      );
    }
    return authorityAgentId;
  }
  if (requestedAgentId) {
    if (!params.allowAgentIdOverride) {
      throw completionError(
        "LLM_COMPLETION_NOT_AUTHORIZED",
        "Plugin LLM completion cannot override the target agent.",
      );
    }
    return requestedAgentId;
  }
  return undefined;
}

function buildPolicyFromEntry(entry: {
  allowAgentIdOverride?: boolean;
  allowModelOverride?: boolean;
  allowAuthProfileOverride?: boolean;
  hasAllowedModelsConfig?: boolean;
  allowedModels?: readonly string[];
  hasAllowedCompletionModelsConfig?: boolean;
  allowedCompletionModels?: readonly string[];
}): RuntimeLlmPolicy {
  return {
    allowAgentIdOverride: entry.allowAgentIdOverride === true,
    allowModelOverride: entry.allowModelOverride === true,
    allowAuthProfileOverride: entry.allowAuthProfileOverride === true,
    overrideModels: compileModelAllowlist({
      configured: entry.hasAllowedModelsConfig === true,
      values: entry.allowedModels,
      formatKey: modelKey,
    }),
    completionModels: compileModelAllowlist({
      configured: entry.hasAllowedCompletionModelsConfig === true,
      values: entry.allowedCompletionModels,
      formatKey: modelKey,
    }),
  };
}

export function resolvePluginPolicyId(
  authority: RuntimeLlmAuthority | undefined,
  caller: LlmCompleteCaller,
): string | undefined {
  const authorityPluginId = normalizeOptionalString(authority?.pluginIdForPolicy);
  if (authorityPluginId) {
    return authorityPluginId;
  }
  if (caller.kind !== "plugin") {
    return undefined;
  }
  const pluginId = normalizeOptionalString(caller.id);
  return pluginId;
}

export function resolvePluginLlmPolicy(
  cfg: OpenClawConfig,
  pluginId: string | undefined,
): RuntimeLlmPolicy | undefined {
  if (!pluginId) {
    return undefined;
  }
  const entry = normalizePluginsConfig(cfg.plugins).entries[pluginId]?.llm;
  return entry ? buildPolicyFromEntry(entry) : undefined;
}

export function resolveAuthorityModelPolicy(
  authority?: RuntimeLlmAuthority,
): RuntimeLlmPolicy | undefined {
  if (
    authority?.allowAgentIdOverride !== true &&
    authority?.allowModelOverride !== true &&
    authority?.allowAuthProfileOverride !== true &&
    authority?.allowedModels === undefined &&
    authority?.allowedCompletionModels === undefined
  ) {
    return undefined;
  }
  return buildPolicyFromEntry({
    allowAgentIdOverride: authority.allowAgentIdOverride,
    allowModelOverride: authority.allowModelOverride,
    allowAuthProfileOverride: authority.allowAuthProfileOverride,
    hasAllowedModelsConfig: authority.allowedModels !== undefined,
    allowedModels: authority.allowedModels,
    hasAllowedCompletionModelsConfig: authority.allowedCompletionModels !== undefined,
    allowedCompletionModels: authority.allowedCompletionModels,
  });
}

export function assertAllowedAuthProfileOverride(params: {
  authProfileId: string | undefined;
  authorityPolicy: RuntimeLlmPolicy | undefined;
  pluginPolicy: RuntimeLlmPolicy | undefined;
}): void {
  if (!params.authProfileId) {
    return;
  }
  if (
    params.authorityPolicy?.allowAuthProfileOverride === true ||
    params.pluginPolicy?.allowAuthProfileOverride === true
  ) {
    return;
  }
  throw completionError(
    "LLM_COMPLETION_NOT_AUTHORIZED",
    "Plugin LLM completion cannot override the auth profile. Enable plugins.entries.<id>.llm.allowAuthProfileOverride to authorize it.",
  );
}

function assertModelAllowed(params: {
  kind: "override" | "completion";
  resolvedModelRef: string | null;
  policy: RuntimeLlmPolicy | undefined;
  policyOwnerPluginId?: string;
}): void {
  const allowlist =
    params.kind === "override" ? params.policy?.overrideModels : params.policy?.completionModels;
  if (!allowlist?.configured || allowlist.allowAny) {
    return;
  }
  const target = params.kind === "override" ? "model override" : "model";
  if (allowlist.models.size === 0) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion ${target} allowlist has no valid models.`,
    );
  }
  if (!params.resolvedModelRef) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion ${target} allowlist requires a resolvable provider/model target.`,
    );
  }
  if (!allowlist.models.has(params.resolvedModelRef)) {
    const owner = params.policyOwnerPluginId ? ` for plugin "${params.policyOwnerPluginId}"` : "";
    const usage = params.kind === "completion" ? " for completions" : "";
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      `Plugin LLM completion ${target} "${params.resolvedModelRef}" is not allowlisted${usage}${owner}.`,
    );
  }
}

export function assertAllowedModelOverride(params: {
  resolvedModelRef: string | null;
  pluginPolicyId: string | undefined;
  authorityPolicy: RuntimeLlmPolicy | undefined;
  pluginPolicy: RuntimeLlmPolicy | undefined;
}): void {
  if (
    params.authorityPolicy?.allowModelOverride !== true &&
    params.pluginPolicy?.allowModelOverride !== true
  ) {
    throw completionError(
      "LLM_COMPLETION_NOT_AUTHORIZED",
      "Plugin LLM completion cannot override the target model.",
    );
  }
  // Host and operator policy are independent trust boundaries. When both
  // configure a restriction, an override must satisfy their intersection.
  assertModelAllowed({
    kind: "override",
    resolvedModelRef: params.resolvedModelRef,
    policy: params.authorityPolicy,
  });
  assertModelAllowed({
    kind: "override",
    resolvedModelRef: params.resolvedModelRef,
    policy: params.pluginPolicy,
    policyOwnerPluginId: params.pluginPolicyId,
  });
}

export function resolveAllowAgentIdOverride(params: {
  authority?: RuntimeLlmAuthority;
  authorityPolicy?: RuntimeLlmPolicy;
  pluginPolicy?: RuntimeLlmPolicy;
}): boolean {
  return params.authority?.allowAgentIdOverride === false
    ? false
    : params.authorityPolicy?.allowAgentIdOverride === true ||
        params.pluginPolicy?.allowAgentIdOverride === true;
}

/** Host and plugin restrictions independently constrain every selected completion. */
export function assertAllowedCompletionModel(params: {
  resolvedModelRef: string | null;
  pluginPolicyId?: string;
  authorityPolicy?: RuntimeLlmPolicy;
  pluginPolicy?: RuntimeLlmPolicy;
}): void {
  assertModelAllowed({
    kind: "completion",
    resolvedModelRef: params.resolvedModelRef,
    policy: params.authorityPolicy,
  });
  assertModelAllowed({
    kind: "completion",
    resolvedModelRef: params.resolvedModelRef,
    policy: params.pluginPolicy,
    policyOwnerPluginId: params.pluginPolicyId,
  });
}
