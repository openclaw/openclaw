import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";

/** Selects operator-facing detail for unresolved SecretRef diagnostics. */
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

/**
 * Resolves a config field that may be plaintext, an env-template string, or a
 * SecretRef object while preserving unresolved reasons for callers that can
 * continue with warnings.
 */
export async function resolveConfiguredSecretInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{ value?: string; unresolvedRefReason?: string }> {
  const style = params.unresolvedReasonStyle ?? "generic";
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  if (!ref) {
    return { value: normalizeOptionalString(params.value) };
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
        unresolvedRefReason: buildUnresolvedReason({
          path: params.path,
          style,
          kind: "empty",
          refLabel,
        }),
      };
    }
    return { value: trimmed };
  } catch {
    return {
      unresolvedRefReason: buildUnresolvedReason({
        path: params.path,
        style,
        kind: "unresolved",
        refLabel,
      }),
    };
  }
}

/**
 * Resolves a config secret input with caller-owned fallback metadata.
 * Fallbacks remain distinguishable from config and SecretRef values so install,
 * status, and plugin SDK paths can avoid persisting accidental env-only secrets.
 */
export async function resolveConfiguredSecretInputWithFallback(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
  readFallback?: () => string | undefined;
}): Promise<{
  value?: string;
  source?: ConfiguredSecretInputSource;
  unresolvedRefReason?: string;
  secretRefConfigured: boolean;
}> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  const configValue = !ref ? normalizeOptionalString(params.value) : undefined;
  if (configValue) {
    return {
      value: configValue,
      source: "config",
      secretRefConfigured: false,
    };
  }
  if (!ref) {
    const fallback = params.readFallback?.();
    if (fallback) {
      return {
        value: fallback,
        source: "fallback",
        secretRefConfigured: false,
      };
    }
    return { secretRefConfigured: false };
  }

  // A SecretRef-backed field may still use a caller fallback, but the result
  // keeps secretRefConfigured=true so operators can see config still needs work.
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.value,
    path: params.path,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    unresolvedReasonStyle: params.unresolvedReasonStyle,
  });
  if (resolved.value) {
    return {
      value: resolved.value,
      source: "secretRef",
      secretRefConfigured: true,
    };
  }

  const fallback = params.readFallback?.();
  if (fallback) {
    return {
      value: fallback,
      source: "fallback",
      secretRefConfigured: true,
    };
  }

  return {
    unresolvedRefReason: resolved.unresolvedRefReason,
    secretRefConfigured: true,
  };
}

/**
 * Requires SecretRef-backed resolution only; plaintext config deliberately
 * returns undefined so callers can patch just the SecretRef value in place.
 */
export async function resolveRequiredConfiguredSecretRefInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<string | undefined> {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    defaults: params.config.secrets?.defaults,
  });
  if (!ref) {
    return undefined;
  }

  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env,
    value: params.value,
    path: params.path,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    unresolvedReasonStyle: params.unresolvedReasonStyle,
  });
  if (resolved.value) {
    return resolved.value;
  }
  throw new Error(resolved.unresolvedRefReason ?? `${params.path} resolved to an empty value.`);
}
