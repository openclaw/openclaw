// Host and plugin completion model policy: which model targets a plugin LLM call may use.
import type { CompiledModelAllowlist } from "../model-allowlist.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";

/** Host or plugin completion policy resolved from configuration. */
export type RuntimeLlmPolicy = {
  allowAgentIdOverride: boolean;
  allowModelOverride: boolean;
  allowAuthProfileOverride: boolean;
  overrideModels: CompiledModelAllowlist;
  completionModels: CompiledModelAllowlist;
};

export function assertModelAllowed(params: {
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
