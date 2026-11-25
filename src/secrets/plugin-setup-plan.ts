import { isValidAgentId } from "@openclaw/normalization-core/agent-id";
import type { PluginIntegrationSecretProviderConfig, SecretRef } from "../config/types.secrets.js";
import { formatConcreteConfigPath, parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import type { SecretsApplyPlan, SecretsPlanTarget } from "./plan.js";
import { isValidSecretProviderAlias } from "./ref-contract.js";
import { resolveSecretPlanTargetByPathCore } from "./target-registry-query.js";

export type PluginSecretRefProviderMapping = {
  providerId: string;
  secretId: string;
};

export type PluginSecretRefConfigTargetMapping = {
  path: string;
  agentId?: string;
  secretId: string;
};

const MODEL_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function assertValidPluginSecretProviderAlias(value: string): void {
  if (!isValidSecretProviderAlias(value)) {
    throw new Error(
      `Invalid provider alias "${value}". Use lowercase letters, numbers, underscores, or hyphens.`,
    );
  }
}

export function assertValidPluginModelProviderId(label: string, value: string): void {
  if (!MODEL_PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label} model provider id: ${value}`);
  }
}

export function parsePluginSecretTargetSpecifier(
  productName: string,
  value: string,
): { path: string; agentId?: string } {
  if (!value.startsWith("auth-profiles:")) {
    return {
      path: value.startsWith("openclaw:") ? value.slice("openclaw:".length) : value,
    };
  }
  const remainder = value.slice("auth-profiles:".length);
  const separatorIndex = remainder.indexOf(":");
  const agentId = separatorIndex >= 0 ? remainder.slice(0, separatorIndex) : "";
  const targetPath = separatorIndex >= 0 ? remainder.slice(separatorIndex + 1) : "";
  if (!isValidAgentId(agentId) || !targetPath) {
    throw new Error(`Invalid --target auth-profiles target for ${productName}: ${value}`);
  }
  return { agentId, path: targetPath };
}

export function buildPluginSecretRefSetupPlan(params: {
  productName: string;
  providerAlias: string;
  providerConfig: PluginIntegrationSecretProviderConfig;
  providerSecrets: PluginSecretRefProviderMapping[];
  configTargetSecrets?: PluginSecretRefConfigTargetMapping[];
  generatedAt?: string;
}): SecretsApplyPlan & {
  providerUpserts: Record<string, PluginIntegrationSecretProviderConfig>;
} {
  assertValidPluginSecretProviderAlias(params.providerAlias);
  const targets = [
    ...params.providerSecrets.map((entry): SecretsPlanTarget => {
      const providerAlias = params.providerAlias;
      const providerId = entry.providerId;
      const secretId = entry.secretId;
      assertValidPluginModelProviderId("target", providerId);
      const pathSegments = ["models", "providers", providerId, "apiKey"];
      return {
        type: "models.providers.apiKey",
        path: formatConcreteConfigPath(pathSegments),
        pathSegments,
        providerId,
        ref: {
          source: "exec",
          provider: providerAlias,
          id: secretId,
        },
      };
    }),
    ...(params.configTargetSecrets ?? []).map((entry): SecretsPlanTarget => {
      const productName = params.productName;
      const providerAlias = params.providerAlias;
      const path = entry.path;
      const agentId = entry.agentId || undefined;
      const secretId = entry.secretId;
      if (agentId && !isValidAgentId(agentId)) {
        throw new Error(`Invalid ${productName} setup agent id: ${agentId}`);
      }
      let parsedPath: Array<string | number>;
      try {
        parsedPath = parseConcreteConfigPathTokens(path);
      } catch {
        throw new Error(`Invalid --target config path: ${path}`);
      }
      const pathSegments = parsedPath.map(String);
      const normalizedPath = formatConcreteConfigPath(parsedPath);
      if (normalizedPath !== path) {
        throw new Error(`Invalid --target config path: ${path}`);
      }
      const resolved = resolveSecretPlanTargetByPathCore({
        configFile: agentId ? "auth-profile-store" : "openclaw.json",
        pathSegments,
        pathTokens: parsedPath,
      });
      if (!resolved) {
        throw new Error(`Unknown or unsupported ${productName} setup target path: ${path}`);
      }
      const ref: SecretRef = {
        source: "exec",
        provider: providerAlias,
        id: secretId,
      };
      return Object.assign(
        { type: resolved.entry.targetType, path: normalizedPath, pathSegments },
        agentId ? { agentId } : {},
        resolved.providerId ? { providerId: resolved.providerId } : {},
        resolved.accountId ? { accountId: resolved.accountId } : {},
        { ref },
      );
    }),
  ];
  const seen = new Set<string>();
  for (const target of targets) {
    const key = target.agentId
      ? `auth-profiles:${target.agentId}:${target.path}`
      : `openclaw:${target.path}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate secret target path in ${params.productName} setup: ${target.path}`,
      );
    }
    seen.add(key);
  }
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    generatedBy: "manual",
    providerUpserts: {
      [params.providerAlias]: params.providerConfig,
    },
    targets,
  };
}
