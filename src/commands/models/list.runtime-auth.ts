import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { AgentHarnessRuntimeAvailability } from "../../agents/harness/runtime-plugin.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityResolver,
} from "../../agents/model-auth-availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthOverview } from "./list.types.js";

type StatusRuntimeAuthStatus = "usable" | "missing" | "indeterminate";
type StatusRuntimeAuthRouteBase = {
  provider: string;
  runtime: string;
  authProvider: string;
  effective: ProviderAuthOverview["effective"];
};
export type StatusRuntimeAuthRoute =
  | (StatusRuntimeAuthRouteBase & { status: StatusRuntimeAuthStatus })
  | (StatusRuntimeAuthRouteBase & {
      status: "unavailable";
      authStatus: StatusRuntimeAuthStatus;
      runtimeStatus: "unavailable";
      runtimeReason: Extract<AgentHarnessRuntimeAvailability, { status: "unavailable" }>["reason"];
      runtimeDetail: string;
      runtimePluginIds: string[];
    });

type StatusRuntimeAuthUsage = { provider: string; model: string; runtime: string };

/** Include native harnesses without treating their login as a provider credential. */
export function collectStatusNativeRuntimeAuthUsages(params: {
  config: OpenClawConfig;
  agentId?: string;
  providerUses: readonly { provider: string; model: string; allowCodexRuntimeFallback: boolean }[];
  cliRuntimeAuthUsages: readonly { provider: string; model: string }[];
  syntheticAuthProviderRefs: ReadonlySet<string>;
}): StatusRuntimeAuthUsage[] {
  return params.providerUses.flatMap((usage) => {
    const harnessRuntime = resolveAgentHarnessPolicy({
      config: params.config,
      agentId: params.agentId,
      provider: usage.provider,
      modelId: usage.model,
    }).runtime;
    return usage.allowCodexRuntimeFallback &&
      harnessRuntime !== "codex" &&
      params.syntheticAuthProviderRefs.has(harnessRuntime) &&
      !params.cliRuntimeAuthUsages.some(
        (candidate) => candidate.provider === usage.provider && candidate.model === usage.model,
      )
      ? [{ provider: usage.provider, model: usage.model, runtime: harnessRuntime }]
      : [];
  });
}

/** Project native and CLI login readiness using each runtime's existing auth evaluator. */
export function buildStatusRuntimeAuthRouteEntries(params: {
  nativeUsages: readonly StatusRuntimeAuthUsage[];
  cliUsages: readonly StatusRuntimeAuthUsage[];
  resolver: ModelAuthAvailabilityResolver;
  resolveEffective: (
    provider: string,
    evaluation: ModelAuthAvailabilityEvaluation,
  ) => ProviderAuthOverview["effective"];
}): Array<readonly [string, StatusRuntimeAuthRoute]> {
  const entries: Array<readonly [string, StatusRuntimeAuthRoute]> = [];
  const append = (
    usage: StatusRuntimeAuthUsage,
    evaluation: ModelAuthAvailabilityEvaluation,
    authProvider: string,
  ) => {
    entries.push([
      `${usage.provider}:${usage.runtime}:${usage.runtime}`,
      {
        provider: usage.provider,
        runtime: usage.runtime,
        authProvider: usage.runtime,
        status:
          evaluation.availability === true
            ? "usable"
            : evaluation.availability === false
              ? "missing"
              : "indeterminate",
        effective: params.resolveEffective(authProvider, evaluation),
      },
    ]);
  };
  for (const usage of params.nativeUsages) {
    append(
      usage,
      params.resolver.evaluateRuntimeModelAuth(usage.provider, {
        modelId: usage.model,
        runtimeId: usage.runtime,
      }),
      usage.provider,
    );
  }
  for (const usage of params.cliUsages) {
    append(usage, params.resolver.evaluateModelAuth(usage.runtime), usage.runtime);
  }
  return entries;
}
