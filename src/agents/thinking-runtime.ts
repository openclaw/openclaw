import {
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../auto-reply/thinking.js";
/** Resolves the concrete harness runtime that owns the next agent turn. */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveAutoAgentHarnessId } from "./harness/support.js";
import { findModelInCatalog } from "./model-catalog-lookup.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";

/** Convert residual auto policy into the built-in fallback when no registry selection is needed. */
export function concretizeAgentRuntime(runtime: string): string {
  return runtime === "auto" ? "openclaw" : runtime;
}

/** Resolves an explicit session override before configured model/provider policy. */
export function resolveEffectiveAgentRuntime(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
}): string {
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.sessionEntry,
    cfg: params.cfg,
  });
  const runtime =
    sessionRuntime ??
    resolveAgentHarnessPolicy({
      provider: params.provider,
      modelId: params.modelId,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }).runtime;
  if (runtime === "auto") {
    // Reuse the loaded harness registry without triggering plugin discovery.
    // This keeps thinking policy aligned with the harness that would own the turn.
    return (
      resolveAutoAgentHarnessId({
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
      }) ?? "openclaw"
    );
  }
  return concretizeAgentRuntime(runtime);
}

/**
 * Falls back to the configured provider model row for a provider/model pair
 * when the caller didn't supply an explicit thinking catalog. Without this,
 * providers whose thinking-profile policy depends on the catalog's
 * `reasoning` flag (e.g. Ollama) treat every model as non-reasoning and
 * silently clamp any requested level down to "off".
 */
function resolveConfiguredThinkingCatalogEntry(
  cfg: OpenClawConfig | undefined,
  provider: string,
  modelId: string,
): ThinkingCatalogEntry[] | undefined {
  if (!cfg) {
    return undefined;
  }
  const entry = findModelInCatalog(buildConfiguredModelCatalog({ cfg }), provider, modelId);
  if (!entry) {
    return undefined;
  }
  return [
    {
      provider,
      id: modelId,
      api: entry.api,
      reasoning: entry.reasoning,
      params: entry.params,
      compat: entry.compat
        ? {
            thinkingFormat: entry.compat.thinkingFormat,
            supportedReasoningEfforts: entry.compat.supportedReasoningEfforts,
          }
        : undefined,
    },
  ];
}

/** Revalidates a turn-local thinking level after fallback selects its actual model/runtime. */
export function resolveCandidateThinkingLevel(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  level?: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  /** Concrete harness already selected by the caller, when selection is pinned. */
  agentRuntime?: string | null;
}): ThinkLevel | undefined {
  if (!params.level) {
    return undefined;
  }
  const concreteRuntime = params.agentRuntime?.trim().toLowerCase();
  const agentRuntime =
    concreteRuntime && concreteRuntime !== "auto" && concreteRuntime !== "default"
      ? concreteRuntime
      : resolveEffectiveAgentRuntime({
          cfg: params.cfg ?? {},
          provider: params.provider,
          modelId: params.modelId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionEntry: params.sessionEntry,
        });
  const catalog =
    params.catalog ??
    resolveConfiguredThinkingCatalogEntry(params.cfg, params.provider, params.modelId);
  const policy = {
    provider: params.provider,
    model: params.modelId,
    level: params.level,
    catalog,
    agentRuntime,
  };
  return isThinkingLevelSupported(policy) ? params.level : resolveSupportedThinkingLevel(policy);
}
