import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildHostingProfileConditions,
  buildHostingProfileSubjects,
  isReadinessCriterionSelectedByHostingProfile,
  resolveHostingProfileSelection,
} from "../hosting/profiles.js";
import { HOSTING_PROFILE_CONTRACT_VERSION } from "../hosting/types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import {
  isReadinessCriterionSelected,
  MODEL_ROUTE_READY_CRITERION_ID,
} from "../readiness/activation.js";
import type { CanonicalReadinessResult, PluginReadinessInput } from "../readiness/conditions.js";
import type { createGatewayReadinessIdentity } from "../readiness/subjects.js";
import type { resolveGatewayAuth } from "./auth.js";
import type { GatewayServerOptions } from "./server-public.js";
import {
  evaluateConfiguredGatewayReadiness,
  type CanonicalGatewayReadinessResult,
  type ReadinessChecker,
} from "./server/readiness.js";

export function buildGatewayPluginReadinessInput(registry: PluginRegistry): PluginReadinessInput {
  const errors = registry.plugins
    .filter((plugin) => plugin.status === "error")
    .map((plugin): PluginReadinessInput["errors"][number] => {
      const error: PluginReadinessInput["errors"][number] = {
        id: plugin.id,
        activated: plugin.activated === true,
        error: plugin.error ?? "unknown plugin load error",
      };
      if (plugin.activationSource) {
        error.activationSource = plugin.activationSource;
      }
      return error;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const unavailable = listActiveDegradedPlugins()
    .map((plugin) => ({
      id: plugin.pluginId,
      diagnostic: toPublicPluginVerificationDiagnostic(plugin.diagnostic),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return { errors, unavailable };
}

export function resolveModelRouteReadinessStartupOptions(
  config: OpenClawConfig,
  hostingProfileOverride: GatewayServerOptions["hostingProfileOverride"],
) {
  const profile = resolveHostingProfileSelection({
    config,
    env: process.env,
    override: hostingProfileOverride,
  })?.profile;
  return isReadinessCriterionSelected(config, MODEL_ROUTE_READY_CRITERION_ID) ||
    (profile &&
      isReadinessCriterionSelectedByHostingProfile(profile, MODEL_ROUTE_READY_CRITERION_ID))
    ? { enabled: true as const }
    : {};
}

export function createHostingProfileGatewayReadinessResolver(params: {
  getSnapshot: () => {
    config: OpenClawConfig;
    auth: ReturnType<typeof resolveGatewayAuth>;
  };
  identity: ReturnType<typeof createGatewayReadinessIdentity>;
  bind: GatewayServerOptions["bind"];
  bindHost: string;
  port: number;
  hostingProfileOverride: GatewayServerOptions["hostingProfileOverride"];
  evaluateGateway: ReadinessChecker;
  evaluateRuntime: () => Promise<CanonicalReadinessResult>;
}) {
  return (): Promise<CanonicalGatewayReadinessResult> => {
    const snapshot = params.getSnapshot();
    const profileSelection = resolveHostingProfileSelection({
      config: snapshot.config,
      env: process.env,
      override: params.hostingProfileOverride,
    });
    const failureContext = profileSelection
      ? {
          conditions: buildHostingProfileConditions(profileSelection.profile, {
            bind: params.bind ?? snapshot.config.gateway?.bind ?? "loopback",
            bindHost: params.bindHost,
            port: params.port,
            authMode: snapshot.auth.mode,
            trustedProxyUserHeader: snapshot.auth.trustedProxy?.userHeader,
            trustedProxySources: snapshot.config.gateway?.trustedProxies ?? [],
            trustedProxyAllowLoopback: snapshot.auth.trustedProxy?.allowLoopback === true,
          }).filter((condition) => condition.type === "ProfileSelected"),
          subjects: buildHostingProfileSubjects(profileSelection),
        }
      : undefined;
    return evaluateConfiguredGatewayReadiness({
      config: snapshot.config,
      identity: params.identity,
      canonicalEvaluationEnabled: profileSelection !== undefined,
      failureContext,
      profileMetadata: profileSelection
        ? {
            profileContractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
            profile: profileSelection.profile,
            profileSource: profileSelection.source,
          }
        : undefined,
      evaluateGateway: params.evaluateGateway,
      evaluateRuntime: params.evaluateRuntime,
    });
  };
}
