import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { callGateway } from "../gateway/call.js";
import { validateSecretsResolveResult } from "../gateway/protocol/index.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "../secrets/command-config.js";
import { setPathExistingStrict } from "../secrets/path-utils.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
import { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { applyResolvedAssignments, createResolverContext } from "../secrets/runtime-shared.js";
import { describeUnknownError } from "../secrets/shared.js";
import { discoverConfigSecretTargetsByIds } from "../secrets/target-registry.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

type ResolveCommandSecretsResult = {
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
};

type GatewaySecretsResolveResult = {
  ok?: boolean;
  assignments?: Array<{
    path?: string;
    pathSegments: string[];
    value: unknown;
  }>;
  diagnostics?: string[];
  inactiveRefPaths?: string[];
};

function dedupeDiagnostics(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function collectConfiguredTargetRefPaths(params: {
  config: OpenClawConfig;
  targetIds: Set<string>;
}): Set<string> {
  const defaults = params.config.secrets?.defaults;
  const configuredTargetRefPaths = new Set<string>();
  for (const target of discoverConfigSecretTargetsByIds(params.config, params.targetIds)) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (ref) {
      configuredTargetRefPaths.add(target.path);
    }
  }
  return configuredTargetRefPaths;
}

function classifyConfiguredTargetRefs(params: {
  config: OpenClawConfig;
  configuredTargetRefPaths: Set<string>;
}): {
  hasActiveConfiguredRef: boolean;
  hasUnknownConfiguredRef: boolean;
  diagnostics: string[];
} {
  if (params.configuredTargetRefPaths.size === 0) {
    return {
      hasActiveConfiguredRef: false,
      hasUnknownConfiguredRef: false,
      diagnostics: [],
    };
  }
  const context = createResolverContext({
    sourceConfig: params.config,
    env: process.env,
  });
  collectConfigAssignments({
    config: structuredClone(params.config),
    context,
  });

  const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
  const inactiveWarningsByPath = new Map<string, string>();
  for (const warning of context.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarningsByPath.set(warning.path, warning.message);
  }

  const diagnostics = new Set<string>();
  let hasActiveConfiguredRef = false;
  let hasUnknownConfiguredRef = false;

  for (const path of params.configuredTargetRefPaths) {
    if (activePaths.has(path)) {
      hasActiveConfiguredRef = true;
      continue;
    }
    const inactiveWarning = inactiveWarningsByPath.get(path);
    if (inactiveWarning) {
      diagnostics.add(inactiveWarning);
      continue;
    }
    hasUnknownConfiguredRef = true;
  }

  return {
    hasActiveConfiguredRef,
    hasUnknownConfiguredRef,
    diagnostics: [...diagnostics],
  };
}

function parseGatewaySecretsResolveResult(payload: unknown): {
  assignments: Array<{ path?: string; pathSegments: string[]; value: unknown }>;
  diagnostics: string[];
  inactiveRefPaths: string[];
} {
  if (!validateSecretsResolveResult(payload)) {
    throw new Error("gateway returned invalid secrets.resolve payload.");
  }
  const parsed = payload as GatewaySecretsResolveResult;
  return {
    assignments: parsed.assignments ?? [],
    diagnostics: (parsed.diagnostics ?? []).filter((entry) => entry.trim().length > 0),
    inactiveRefPaths: (parsed.inactiveRefPaths ?? []).filter((entry) => entry.trim().length > 0),
  };
}

function collectInactiveSurfacePathsFromDiagnostics(diagnostics: string[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of diagnostics) {
    const marker = ": secret ref is configured on an inactive surface;";
    const markerIndex = entry.indexOf(marker);
    if (markerIndex <= 0) {
      continue;
    }
    const path = entry.slice(0, markerIndex).trim();
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return paths;
}

function isUnsupportedSecretsResolveError(err: unknown): boolean {
  const message = describeUnknownError(err).toLowerCase();
  if (!message.includes("secrets.resolve")) {
    return false;
  }
  return (
    message.includes("does not support required method") ||
    message.includes("unknown method") ||
    message.includes("method not found") ||
    message.includes("invalid request")
  );
}

async function resolveCommandSecretRefsLocally(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  preflightDiagnostics: string[];
}): Promise<ResolveCommandSecretsResult> {
  const sourceConfig = params.config;
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: process.env,
  });
  collectConfigAssignments({
    config: resolvedConfig,
    context,
  });
  if (context.assignments.length > 0) {
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  const inactiveRefPaths = new Set(
    context.warnings
      .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
      .map((warning) => warning.path),
  );
  const commandAssignments = collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths,
  });

  return {
    resolvedConfig,
    diagnostics: dedupeDiagnostics([
      ...params.preflightDiagnostics,
      ...commandAssignments.diagnostics,
    ]),
  };
}

export async function resolveCommandSecretRefsViaGateway(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
}): Promise<ResolveCommandSecretsResult> {
  const configuredTargetRefPaths = collectConfiguredTargetRefPaths({
    config: params.config,
    targetIds: params.targetIds,
  });
  if (configuredTargetRefPaths.size === 0) {
    return { resolvedConfig: params.config, diagnostics: [] };
  }
  const preflight = classifyConfiguredTargetRefs({
    config: params.config,
    configuredTargetRefPaths,
  });
  if (!preflight.hasActiveConfiguredRef && !preflight.hasUnknownConfiguredRef) {
    return {
      resolvedConfig: params.config,
      diagnostics: preflight.diagnostics,
    };
  }

  let payload: GatewaySecretsResolveResult;
  try {
    payload = await callGateway<GatewaySecretsResolveResult>({
      method: "secrets.resolve",
      requiredMethods: ["secrets.resolve"],
      params: {
        commandName: params.commandName,
        targetIds: [...params.targetIds],
      },
      timeoutMs: 30_000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (err) {
    try {
      const fallback = await resolveCommandSecretRefsLocally({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        preflightDiagnostics: preflight.diagnostics,
      });
      return {
        resolvedConfig: fallback.resolvedConfig,
        diagnostics: dedupeDiagnostics([
          ...fallback.diagnostics,
          `${params.commandName}: gateway secrets.resolve unavailable (${describeUnknownError(err)}); resolved command secrets locally.`,
        ]),
      };
    } catch {
      // Fall through to original gateway-specific error reporting.
    }
    if (isUnsupportedSecretsResolveError(err)) {
      throw new Error(
        `${params.commandName}: active gateway does not support secrets.resolve (${describeUnknownError(err)}). Update the gateway or run without SecretRefs.`,
        { cause: err },
      );
    }
    throw new Error(
      `${params.commandName}: failed to resolve secrets from the active gateway snapshot (${describeUnknownError(err)}). Start the gateway and retry.`,
      { cause: err },
    );
  }

  const parsed = parseGatewaySecretsResolveResult(payload);
  const resolvedConfig = structuredClone(params.config);
  for (const assignment of parsed.assignments) {
    const pathSegments = assignment.pathSegments.filter((segment) => segment.length > 0);
    if (pathSegments.length === 0) {
      continue;
    }
    try {
      setPathExistingStrict(resolvedConfig, pathSegments, assignment.value);
    } catch (err) {
      const path = pathSegments.join(".");
      throw new Error(
        `${params.commandName}: failed to apply resolved secret assignment at ${path} (${describeUnknownError(err)}).`,
        { cause: err },
      );
    }
  }
  const inactiveRefPaths =
    parsed.inactiveRefPaths.length > 0
      ? new Set(parsed.inactiveRefPaths)
      : collectInactiveSurfacePathsFromDiagnostics(parsed.diagnostics);
  collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig: params.config,
    resolvedConfig,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths,
  });

  return {
    resolvedConfig,
    diagnostics: dedupeDiagnostics(parsed.diagnostics),
  };
}
