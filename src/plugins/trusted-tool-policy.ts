import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPlainObject } from "../utils.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookToolInputKind,
  PluginHookToolKind,
  PluginToolMatcher,
} from "./hook-types.js";
import { getPluginSessionExtensionStateSync } from "./host-hook-state.js";
import type { PluginJsonValue, PluginTrustedToolPolicyRegistration } from "./host-hooks.js";
import type {
  PluginRegistry,
  PluginTrustedToolPolicyRegistryRegistration,
} from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  createPluginToolMatcherScope,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

type TrustedPolicyRegistration = PluginTrustedToolPolicyRegistryRegistration;
type TrustedToolPolicyRegistry =
  | { trustedToolPolicies?: PluginRegistry["trustedToolPolicies"] }
  | null
  | undefined;

/** Diagnostic entry for an installed trusted tool policy. */
type TrustedToolPolicyDiagnosticEntry = {
  id: string;
  pluginId: string;
  pluginName?: string;
};

/** True when the supplied or active plugin registry has trusted tool policies. */
export function hasTrustedToolPolicies(
  registry: TrustedToolPolicyRegistry = getActivePluginRegistry(),
): boolean {
  return copyTrustedPolicyRegistrations(registry).length > 0;
}

function unreadableTrustedPolicyRegistration(): TrustedPolicyRegistration {
  return {
    pluginId: "unknown-plugin",
    source: "runtime",
    get policy(): PluginTrustedToolPolicyRegistration {
      throw new Error("trusted policy registration is unreadable");
    },
  };
}

function copyTrustedPolicyRegistrations(
  registry: TrustedToolPolicyRegistry,
): TrustedPolicyRegistration[] {
  try {
    const policies: unknown = registry?.trustedToolPolicies;
    if (!policies) {
      return [];
    }
    return Array.isArray(policies)
      ? policies.map((policy) => policy)
      : [unreadableTrustedPolicyRegistration()];
  } catch {
    return [unreadableTrustedPolicyRegistration()];
  }
}

function readTrustedPolicyPluginString(
  registration: TrustedPolicyRegistration,
  key: "pluginId" | "pluginName",
): string | undefined {
  try {
    const value = registration[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function trustedPolicyDiagnosticPluginId(registration: TrustedPolicyRegistration): string {
  return readTrustedPolicyPluginString(registration, "pluginId") ?? "unknown-plugin";
}

function readTrustedPolicy(
  registration: TrustedPolicyRegistration,
): PluginTrustedToolPolicyRegistration | undefined {
  try {
    const policy = registration.policy;
    return policy && typeof policy.evaluate === "function" ? policy : undefined;
  } catch {
    return undefined;
  }
}

// Undefined is a valid unrestricted matcher; null marks an unreadable policy.
function readTrustedPolicyMatcher(
  policy: PluginTrustedToolPolicyRegistration,
): PluginToolMatcher | null | undefined {
  try {
    return normalizePluginToolMatcher(policy.matcher);
  } catch {
    return null;
  }
}

export function getTrustedToolPolicyMatcherScope(
  registry: TrustedToolPolicyRegistry = getActivePluginRegistry(),
): PluginToolMatcherScope | undefined {
  return createPluginToolMatcherScope(
    copyTrustedPolicyRegistrations(registry).map((registration) => {
      const policy = readTrustedPolicy(registration);
      if (!policy) {
        return undefined;
      }
      const matcher = readTrustedPolicyMatcher(policy);
      // Relay every tool so malformed trusted policy state reaches the fail-closed runtime check.
      return matcher ?? undefined;
    }),
  );
}

function readTrustedPolicyId(registration: TrustedPolicyRegistration): string {
  const fallback = trustedPolicyDiagnosticPluginId(registration);
  const policy = readTrustedPolicy(registration);
  if (!policy) {
    return fallback;
  }
  try {
    const id = policy.id;
    return typeof id === "string" && id.trim() ? id.trim() : fallback;
  } catch {
    return fallback;
  }
}

function trustedPolicyDefaultBlockReason(registration: TrustedPolicyRegistration): string {
  return `blocked by ${readTrustedPolicyId(registration)}`;
}

function trustedPolicyFailureResult(
  registration: TrustedPolicyRegistration,
  detail: string,
): PluginHookBeforeToolCallResult {
  return {
    block: true,
    blockReason: `${trustedPolicyDefaultBlockReason(registration)}: ${detail}`,
  };
}

/** Lists trusted tool policies for status and diagnostics. */
export function getTrustedToolPolicyDiagnosticEntries(
  registry: TrustedToolPolicyRegistry = getActivePluginRegistry(),
): TrustedToolPolicyDiagnosticEntry[] {
  return copyTrustedPolicyRegistrations(registry).map((registration) => {
    const entry: TrustedToolPolicyDiagnosticEntry = {
      id: readTrustedPolicyId(registration),
      pluginId: trustedPolicyDiagnosticPluginId(registration),
    };
    const pluginName = readTrustedPolicyPluginString(registration, "pluginName");
    if (pluginName) {
      entry.pluginName = pluginName;
    }
    return entry;
  });
}

function normalizeDerivedEventFields(
  value: Pick<PluginHookBeforeToolCallEvent, "derivedPaths"> | undefined,
): Pick<PluginHookBeforeToolCallEvent, "derivedPaths"> {
  return Array.isArray(value?.derivedPaths)
    ? { derivedPaths: Object.freeze([...value.derivedPaths]) }
    : {};
}

function normalizeToolIdentity(
  value:
    | Pick<PluginHookBeforeToolCallEvent, "toolKind" | "toolInputKind">
    | Pick<PluginHookToolContext, "toolKind" | "toolInputKind">
    | undefined,
): { toolKind?: PluginHookToolKind; toolInputKind?: PluginHookToolInputKind } {
  return {
    ...(value?.toolKind && { toolKind: value.toolKind }),
    ...(value?.toolInputKind && { toolInputKind: value.toolInputKind }),
  };
}

/** Runs trusted tool policies before a tool call and returns the first terminal decision. */
export async function runTrustedToolPolicies(
  event: PluginHookBeforeToolCallEvent,
  ctx: PluginHookToolContext,
  options?: {
    config?: OpenClawConfig;
    deriveEvent?: (
      params: Record<string, unknown>,
    ) =>
      | Pick<PluginHookBeforeToolCallEvent, "derivedPaths">
      | Promise<Pick<PluginHookBeforeToolCallEvent, "derivedPaths">>;
    normalizeEvent?: (
      event: PluginHookBeforeToolCallEvent,
      ctx: PluginHookToolContext,
    ) =>
      | {
          params?: Record<string, unknown>;
          event?: Pick<PluginHookBeforeToolCallEvent, "toolKind" | "toolInputKind">;
          ctx?: Pick<PluginHookToolContext, "toolKind" | "toolInputKind">;
        }
      | undefined;
    registry?: TrustedToolPolicyRegistry;
  },
): Promise<PluginHookBeforeToolCallResult | undefined> {
  const policies = copyTrustedPolicyRegistrations(options?.registry ?? getActivePluginRegistry());
  let adjustedParams = event.params;
  let hasAdjustedParams = false;
  let approval: PluginHookBeforeToolCallResult["requireApproval"];
  const sessionExtensionStateCache = new Map<string, Record<string, PluginJsonValue> | undefined>();
  let resolvedSessionConfig: OpenClawConfig | undefined = options?.config;
  let didResolveSessionConfig = Boolean(options?.config);
  const resolveSessionConfig = (): OpenClawConfig | undefined => {
    if (!didResolveSessionConfig) {
      didResolveSessionConfig = true;
      try {
        resolvedSessionConfig = getRuntimeConfig();
      } catch {
        resolvedSessionConfig = undefined;
      }
    }
    return resolvedSessionConfig;
  };
  const { derivedPaths, toolKind, toolInputKind, ...eventWithoutDerivedPaths } = event;
  const { toolKind: ctxToolKind, toolInputKind: ctxToolInputKind, ...ctxWithoutToolIdentity } = ctx;
  let currentDerivedEvent = normalizeDerivedEventFields({ derivedPaths });
  let currentEventToolIdentity = normalizeToolIdentity({ toolKind, toolInputKind });
  let currentContextToolIdentity = normalizeToolIdentity({
    toolKind: ctxToolKind,
    toolInputKind: ctxToolInputKind,
  });
  const buildEvent = (params: Record<string, unknown>): PluginHookBeforeToolCallEvent => ({
    ...eventWithoutDerivedPaths,
    params,
    ...currentEventToolIdentity,
    ...currentDerivedEvent,
  });
  for (const registration of policies) {
    const pluginId = readTrustedPolicyPluginString(registration, "pluginId");
    if (!pluginId) {
      return trustedPolicyFailureResult(registration, "policy owner is unreadable");
    }
    const policyCtx: PluginHookToolContext = {
      ...ctxWithoutToolIdentity,
      ...currentContextToolIdentity,
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Plugin callers type JSON reads by namespace.
      getSessionExtension: <T extends PluginJsonValue = PluginJsonValue>(namespace: string) => {
        const normalizedNamespace = namespace.trim();
        if (!sessionExtensionStateCache.has(pluginId)) {
          const config = ctx.sessionKey ? resolveSessionConfig() : undefined;
          sessionExtensionStateCache.set(
            pluginId,
            config
              ? getPluginSessionExtensionStateSync({
                  cfg: config,
                  pluginId,
                  sessionKey: ctx.sessionKey,
                  agentId: ctx.agentId,
                })
              : undefined,
          );
        }
        const pluginState = sessionExtensionStateCache.get(pluginId);
        if (!normalizedNamespace || !pluginState) {
          return undefined;
        }
        return pluginState[normalizedNamespace] as T | undefined;
      },
    };
    const policy = readTrustedPolicy(registration);
    if (!policy) {
      return trustedPolicyFailureResult(registration, "policy is unreadable");
    }
    const matcher = readTrustedPolicyMatcher(policy);
    if (matcher === null) {
      return trustedPolicyFailureResult(registration, "policy matcher is unreadable");
    }
    if (!pluginToolMatcherCoversTool(matcher, event.toolName)) {
      continue;
    }

    let decision: Awaited<ReturnType<PluginTrustedToolPolicyRegistration["evaluate"]>>;
    try {
      decision = await policy.evaluate(buildEvent(adjustedParams), policyCtx);
    } catch {
      return trustedPolicyFailureResult(registration, "policy evaluation failed");
    }
    if (!decision) {
      continue;
    }
    try {
      // Policies run in order; block decisions are terminal, mutations feed later policies.
      if ("allow" in decision && decision.allow === false) {
        return {
          block: true,
          blockReason: decision.reason ?? trustedPolicyDefaultBlockReason(registration),
        };
      }
      // `block: true` is terminal; normalize a missing blockReason to a deterministic
      // reason so downstream diagnostics match the `{ allow: false }` path above.
      if ("block" in decision && decision.block === true) {
        return {
          ...decision,
          blockReason: decision.blockReason ?? trustedPolicyDefaultBlockReason(registration),
        };
      }
      // `block: false` is a no-op (matches the regular `before_tool_call` hook
      // pipeline) — it does NOT short-circuit the policy chain. Params and
      // approvals are remembered so later trusted policies can still inspect or
      // block the final call.
      if ("params" in decision && isPlainObject(decision.params)) {
        const normalized = options?.normalizeEvent?.(buildEvent(decision.params), policyCtx);
        adjustedParams = normalized?.params ?? decision.params;
        if (normalized?.event) {
          currentEventToolIdentity = normalizeToolIdentity(normalized.event);
        }
        if (normalized?.ctx) {
          currentContextToolIdentity = normalizeToolIdentity(normalized.ctx);
        } else if (normalized?.event) {
          currentContextToolIdentity = normalizeToolIdentity(normalized.event);
        }
        hasAdjustedParams = true;
        currentDerivedEvent = normalizeDerivedEventFields(
          await options?.deriveEvent?.(adjustedParams),
        );
      }
      if ("requireApproval" in decision && decision.requireApproval && !approval) {
        approval = decision.requireApproval;
      }
    } catch {
      ctx.abortSignal?.throwIfAborted();
      return trustedPolicyFailureResult(registration, "policy decision is unreadable");
    }
  }
  if (!hasAdjustedParams && !approval) {
    return undefined;
  }
  return {
    ...(hasAdjustedParams ? { params: adjustedParams } : {}),
    ...(approval ? { requireApproval: approval } : {}),
  };
}
