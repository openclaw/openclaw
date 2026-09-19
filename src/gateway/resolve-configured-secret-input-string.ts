// SecretRef-aware Gateway config string resolver.
// Resolves configured secret inputs and fallback values without leaking values.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getConfigResolutionFacts, resolveConfigSecretRef } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import {
  describeSecretResolutionOperatorDiagnostic,
  describeSecretResolutionOperatorRecovery,
  isSecretResolutionError,
} from "../secrets/resolve-errors.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
import { formatConcreteConfigPath, tokenizeConcreteConfigPath } from "../shared/dot-path.js";

export type SecretInputUnresolvedReasonStyle = "generic" | "detailed"; // pragma: allowlist secret
type ConfiguredSecretInputSource =
  | "config"
  | "secretRef" // pragma: allowlist secret
  | "fallback";

function buildUnresolvedReason(params: {
  path: string;
  style: SecretInputUnresolvedReasonStyle;
  kind: "unresolved" | "non-string" | "empty";
  refLabel: string;
}): string {
  if (params.style === "generic") {
    return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
  }
  if (params.kind === "non-string") {
    return `${params.path} SecretRef resolved to a non-string value.`;
  }
  if (params.kind === "empty") {
    return `${params.path} SecretRef resolved to an empty value.`;
  }
  return `${params.path} SecretRef is unresolved (${params.refLabel}).`;
}

type ConfiguredSecretInputParams = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
};

async function resolveConfiguredSecretInput(params: ConfiguredSecretInputParams): Promise<{
  refConfigured: boolean;
  value?: string;
  unresolvedRefReason?: string;
  unresolvedRefCode?: "SECRET_REF_REDACTED_VALUE";
}> {
  const style = params.unresolvedReasonStyle ?? "generic";
  let configPath = params.path;
  if (typeof params.value === "string" && getConfigResolutionFacts(params.config) !== null) {
    try {
      configPath = formatConcreteConfigPath(
        tokenizeConcreteConfigPath(configPath).tokens,
        params.config,
      );
    } catch {
      // The public helper also accepts diagnostic labels that are not configuration paths.
    }
  }
  const ref = resolveConfigSecretRef({
    config: params.config,
    path: configPath,
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  if (!ref) {
    return { refConfigured: false, value: normalizeOptionalString(params.value) };
  }

  const refLabel = `${ref.source}:${ref.provider}:${ref.id}`;
  try {
    const resolved = await resolveSecretRefValues([ref], {
      config: params.config,
      env: params.env,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    });
    const resolvedValue = resolved.get(secretRefKey(ref));
    if (typeof resolvedValue !== "string") {
      return {
        refConfigured: true,
        unresolvedRefReason: buildUnresolvedReason({
          path: params.path,
          style,
          kind: "non-string",
          refLabel,
        }),
      };
    }
    const trimmed = normalizeOptionalString(resolvedValue);
    if (!trimmed) {
      return {
        refConfigured: true,
        unresolvedRefReason: buildUnresolvedReason({
          path: params.path,
          style,
          kind: "empty",
          refLabel,
        }),
      };
    }
    return { refConfigured: true, value: trimmed };
  } catch (error) {
    const redactedValue =
      isSecretResolutionError(error) && error.code === "SECRET_REF_REDACTED_VALUE";
    const operatorDiagnostic =
      style === "detailed" || redactedValue
        ? describeSecretResolutionOperatorDiagnostic(error)
        : undefined;
    const operatorRecovery =
      style === "detailed" || redactedValue
        ? describeSecretResolutionOperatorRecovery(error)
        : undefined;
    const unresolvedReason = buildUnresolvedReason({
      path: params.path,
      style,
      kind: "unresolved",
      refLabel,
    });
    const operatorDetail = [operatorDiagnostic, operatorRecovery].filter(Boolean).join(". ");
    return {
      refConfigured: true,
      ...(redactedValue ? { unresolvedRefCode: "SECRET_REF_REDACTED_VALUE" as const } : {}),
      unresolvedRefReason: operatorDetail
        ? `${unresolvedReason} ${operatorDetail}.`
        : unresolvedReason,
    };
  }
}

export async function resolveConfiguredSecretInputString(
  params: ConfiguredSecretInputParams,
): Promise<{
  value?: string;
  unresolvedRefReason?: string;
  unresolvedRefCode?: "SECRET_REF_REDACTED_VALUE";
}> {
  const { refConfigured: _refConfigured, ...resolved } = await resolveConfiguredSecretInput(params);
  return resolved;
}

export async function resolveConfiguredSecretInputWithFallback(
  params: ConfiguredSecretInputParams & {
    readFallback?: () => string | undefined;
  },
): Promise<{
  value?: string;
  source?: ConfiguredSecretInputSource;
  unresolvedRefReason?: string;
  unresolvedRefCode?: "SECRET_REF_REDACTED_VALUE";
  secretRefConfigured: boolean;
}> {
  const resolved = await resolveConfiguredSecretInput(params);
  const configValue = !resolved.refConfigured ? resolved.value : undefined;
  if (configValue) {
    return {
      value: configValue,
      source: "config",
      secretRefConfigured: false,
    };
  }
  if (!resolved.refConfigured) {
    const fallback = normalizeOptionalString(params.readFallback?.());
    if (fallback) {
      // Fallbacks are only returned after direct config is absent, preserving
      // explicit config precedence while still allowing credential stores.
      return {
        value: fallback,
        source: "fallback",
        secretRefConfigured: false,
      };
    }
    return { secretRefConfigured: false };
  }

  if (resolved.value) {
    return {
      value: resolved.value,
      source: "secretRef",
      secretRefConfigured: true,
    };
  }

  return {
    unresolvedRefReason: resolved.unresolvedRefReason,
    ...(resolved.unresolvedRefCode ? { unresolvedRefCode: resolved.unresolvedRefCode } : {}),
    secretRefConfigured: true,
  };
}

export async function resolveRequiredConfiguredSecretRefInputString(
  params: ConfiguredSecretInputParams,
): Promise<string | undefined> {
  const resolved = await resolveConfiguredSecretInput(params);
  if (!resolved.refConfigured) {
    return undefined;
  }
  if (resolved.value) {
    return resolved.value;
  }
  throw new Error(resolved.unresolvedRefReason ?? `${params.path} resolved to an empty value.`);
}
