import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSupportedThinkingLevel,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../auto-reply/thinking.js";
/** Resolves the concrete harness runtime that owns the next agent turn. */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/availability.js";
import { resolveAutoAgentHarnessId } from "./harness/support.js";
import type { AgentRuntimePolicyScope } from "./model-runtime-policy.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";

export function hasResolvedThinkingCatalogEntry(params: {
  catalog?: readonly ThinkingCatalogEntry[];
  provider: string;
  model: string;
  agentRuntime?: string;
}): boolean {
  const modelId = normalizeOptionalString(params.model);
  if (!modelId) {
    return false;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  const entry = params.catalog?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizedProvider && candidate.id === modelId,
  );
  return (
    entry?.reasoning !== undefined &&
    (params.agentRuntime === undefined ||
      entry.nativeRuntime === undefined ||
      entry.nativeRuntime === params.agentRuntime)
  );
}

/** Native runtimes resolve their own observations; host turns cannot borrow native-only facts. */
export function needsThinkHydration(
  catalog: readonly ThinkingCatalogEntry[] | undefined,
  provider: string,
  model: string,
  agentRuntime: string,
): boolean {
  return (
    agentRuntime !== "openclaw" ||
    !hasResolvedThinkingCatalogEntry({ catalog, provider, model, agentRuntime })
  );
}

export function normalizeThinkingCatalogProviders<T extends ThinkingCatalogEntry>(
  catalog: readonly T[],
): T[] {
  return catalog.map((entry) => {
    const provider = normalizeProviderId(entry.provider);
    return provider === entry.provider ? entry : Object.assign({}, entry, { provider });
  });
}

/** Convert residual auto policy into the built-in fallback when no registry selection is needed. */
export function concretizeAgentRuntime(runtime: string): string {
  return runtime === "auto" ? "openclaw" : runtime;
}

/** Resolves an explicit session override before configured model/provider policy. */
export function resolveEffectiveAgentRuntime(
  params: {
    cfg: OpenClawConfig;
    provider: string;
    modelId: string;
    modelApi?: string | null;
    modelBaseUrl?: unknown;
    sessionEntry?: Pick<
      SessionEntry,
      "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked"
    >;
    /** Execution applies the implicit-runtime fallback that a turn would take. */
    mode?: "execution" | "projection";
  } & AgentRuntimePolicyScope,
): string {
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.sessionEntry,
    cfg: params.cfg,
  });
  const runtime = resolveAvailableAgentHarnessPolicy({
    ...params,
    mode: params.mode ?? "projection",
    config: params.cfg,
    modelProvider: {
      api: params.modelApi ?? undefined,
      baseUrl: normalizeOptionalString(params.modelBaseUrl),
    },
    agentHarnessId: params.sessionEntry?.modelSelectionLocked ? sessionRuntime : undefined,
    agentHarnessRuntimeOverride: sessionRuntime,
  }).runtime;
  if (runtime === "auto") {
    // Reuse the loaded harness registry without triggering plugin discovery.
    // This keeps thinking policy aligned with the harness that would own the turn.
    return (
      resolveAutoAgentHarnessId({
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
        ...(params.agentScope
          ? { agentScope: params.agentScope, sessionKey: params.sessionKey }
          : {}),
      }) ?? "openclaw"
    );
  }
  return concretizeAgentRuntime(runtime);
}

/** Resolves the concrete runtime that owns a candidate turn; a concrete caller selection wins. */
export function resolveCandidateAgentRuntime(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  /** Concrete harness already selected by the caller, when selection is pinned. */
  agentRuntime?: string | null;
}): string {
  const concreteRuntime = params.agentRuntime?.trim().toLowerCase();
  if (concreteRuntime && concreteRuntime !== "auto" && concreteRuntime !== "default") {
    return concreteRuntime;
  }
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg ?? {},
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
  });
}

/** Revalidates a turn-local thinking level after fallback selects its actual model/runtime. */
export function resolveCandidateThinkingLevel(
  params: Parameters<typeof resolveCandidateAgentRuntime>[0] & {
    level?: ThinkLevel;
    catalog?: ThinkingCatalogEntry[];
  },
): ThinkLevel | undefined {
  if (!params.level) {
    return undefined;
  }
  return resolveSupportedThinkingLevel({
    provider: params.provider,
    model: params.modelId,
    level: params.level,
    catalog: params.catalog,
    agentRuntime: resolveCandidateAgentRuntime(params),
  });
}
