import type { OpenClawConfig } from "../config/config.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { callGateway } from "../gateway/call.js";
import { validateSecretsResolveResult } from "../gateway/protocol/index.js";
import { collectCommandSecretAssignmentsFromSnapshot } from "../secrets/command-config.js";
import { setPathExistingStrict } from "../secrets/path-utils.js";
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
};

function isConfiguredSecretRefTarget(params: {
  config: OpenClawConfig;
  targetIds: Set<string>;
}): boolean {
  const defaults = params.config.secrets?.defaults;
  for (const target of discoverConfigSecretTargetsByIds(params.config, params.targetIds)) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (ref) {
      return true;
    }
  }
  return false;
}

function parseGatewaySecretsResolveResult(payload: unknown): {
  assignments: Array<{ path?: string; pathSegments: string[]; value: unknown }>;
  diagnostics: string[];
} {
  if (!validateSecretsResolveResult(payload)) {
    throw new Error("gateway returned invalid secrets.resolve payload.");
  }
  const parsed = payload as GatewaySecretsResolveResult;
  return {
    assignments: parsed.assignments ?? [],
    diagnostics: (parsed.diagnostics ?? []).filter((entry) => entry.trim().length > 0),
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

export async function resolveCommandSecretRefsViaGateway(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
}): Promise<ResolveCommandSecretsResult> {
  if (!isConfiguredSecretRefTarget({ config: params.config, targetIds: params.targetIds })) {
    return { resolvedConfig: params.config, diagnostics: [] };
  }

  let payload: GatewaySecretsResolveResult;
  try {
    payload = await callGateway<GatewaySecretsResolveResult>({
      method: "secrets.resolve",
      params: {
        commandName: params.commandName,
        targetIds: [...params.targetIds],
      },
      timeoutMs: 30_000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (err) {
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
  const inactiveRefPaths = collectInactiveSurfacePathsFromDiagnostics(parsed.diagnostics);
  collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig: params.config,
    resolvedConfig,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths,
  });

  return {
    resolvedConfig,
    diagnostics: parsed.diagnostics,
  };
}
