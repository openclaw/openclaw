import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { FastMode, ModelsProbeResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type ModelBehaviorConfig = {
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
};

export function readModelBehaviorConfig(
  agentsDefaults: Record<string, unknown> | null,
): ModelBehaviorConfig {
  const thinkingValue = agentsDefaults?.thinkingDefault;
  const fastValue = agentsDefaults?.fastModeDefault;
  return {
    thinkingLevel: typeof thinkingValue === "string" ? thinkingValue : undefined,
    thinkingOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "thinkingDefault"),
    fastMode: fastValue === "auto" || typeof fastValue === "boolean" ? fastValue : undefined,
    fastModeOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "fastModeDefault"),
  };
}

/**
 * Removing or reordering fallbacks shrinks a config array; the gateway's
 * destructive-array guard rejects such merge patches unless the exact path is
 * confirmed via replacePaths.
 */
export const DEFAULT_MODELS_REPLACE_PATHS = ["agents.defaults.model.fallbacks"];

export function buildDefaultsPatch(params: {
  primary: string;
  fallbacks: readonly string[];
  utilityModel: string | null;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
}) {
  return {
    agents: {
      defaults: {
        ...(params.primary
          ? {
              model:
                params.fallbacks.length > 0
                  ? { primary: params.primary, fallbacks: [...params.fallbacks] }
                  : params.primary,
            }
          : {}),
        utilityModel: params.utilityModel,
        thinkingDefault:
          params.thinkingOverridden && params.thinkingLevel ? params.thinkingLevel : null,
        fastModeDefault:
          params.fastModeOverridden && params.fastMode !== undefined ? params.fastMode : null,
      },
    },
  };
}

const PROBE_FAILURE_PRIORITY: readonly ModelsProbeResult["status"][] = [
  "auth",
  "billing",
  "rate_limit",
  "timeout",
  "format",
  "no_model",
  "unknown",
];

export function isMissingMethodError(error: unknown): boolean {
  return /method (?:not found|not supported)|unknown method/iu.test(
    modelProviderErrorMessage(error),
  );
}

export function mergeProbeResults(cardId: string, results: ModelsProbeResult[]): ModelsProbeResult {
  if (results.length === 1) {
    return results[0]!;
  }
  const status = results.some((result) => result.status === "ok")
    ? "ok"
    : (PROBE_FAILURE_PRIORITY.find((candidate) =>
        results.some((result) => result.status === candidate),
      ) ?? "unknown");
  const error = results.find((result) => result.status === status)?.error;
  return {
    provider: cardId,
    status,
    ...(error ? { error } : {}),
    results: results.flatMap((result) =>
      result.results.map((target) => ({
        ...target,
        label: `${result.provider}: ${target.label}`,
      })),
    ),
  };
}

export type ModelProviderRowMessage = {
  kind: "success" | "error";
  text: string;
  warning?: string;
};

export type ModelProviderConfigMutation = {
  key: string;
  raw: Record<string, unknown>;
  note: string;
  success: string;
  replacePaths?: string[];
};

export type ModelProviderConfigMutationResult =
  | { ok: false }
  | { ok: true; agentEpoch: number; warning: string | null };

type ModelProviderConfigMutationOwner = {
  runtimeConfig: RuntimeConfigCapability;
  agentEpoch: number;
  isCurrentClient: () => boolean;
  isCurrentAgent: () => boolean;
  refreshProviders: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setMessage: (message: ModelProviderRowMessage | null) => void;
};

export function modelProviderErrorMessage(error: unknown): string {
  return formatUiError(error, t("modelProviders.requestFailed"));
}

/**
 * Config patches are global; the initiating agent owns only busy/message UI.
 * Refresh warnings must preserve an already acknowledged mutation.
 */
export async function runModelProviderConfigMutation(
  owner: ModelProviderConfigMutationOwner,
  params: ModelProviderConfigMutation,
): Promise<ModelProviderConfigMutationResult> {
  const { agentEpoch, runtimeConfig } = owner;
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    await runtimeConfig.ensureLoaded();
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    const patched = await runtimeConfig.patch({
      raw: params.raw,
      note: params.note,
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    });
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (!patched) {
      if (owner.isCurrentAgent()) {
        owner.setMessage({
          kind: "error",
          text: runtimeConfig.state.lastError ?? t("modelProviders.configUnavailable"),
        });
      }
      return { ok: false };
    }

    let warning: string | null = null;
    try {
      await runtimeConfig.refresh();
      // The config owner records ordinary config.get failures in lastError
      // and resolves refresh(), so rejection alone cannot detect them.
      warning = runtimeConfig.state.lastError;
      if (!warning && owner.isCurrentClient()) {
        await owner.refreshProviders();
      }
    } catch (error) {
      // An acknowledged config patch is already committed; a later refresh
      // failure must not turn it into a failed credential edit.
      warning = modelProviderErrorMessage(error);
    }
    if (!owner.isCurrentClient()) {
      return { ok: false };
    }
    if (owner.isCurrentAgent()) {
      owner.setMessage({
        kind: "success",
        text: params.success,
        ...(warning ? { warning } : {}),
      });
    }
    return { ok: true, agentEpoch, warning };
  } catch (error) {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setMessage({ kind: "error", text: modelProviderErrorMessage(error) });
    }
    return { ok: false };
  } finally {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setBusy(false);
    }
  }
}

/** Credential writes share config serialization and retain acknowledged success during refresh. */
export async function runModelProviderApiKeyMutation(
  owner: Omit<ModelProviderConfigMutationOwner, "refreshProviders"> & {
    canMutate: () => boolean;
    refreshProviders: () => Promise<string | null>;
  },
  params: {
    client: GatewayBrowserClient;
    agentId: string;
    provider: string;
    apiKey: string | null;
    success: string;
  },
): Promise<ModelProviderConfigMutationResult> {
  const isCurrent = () => owner.isCurrentClient() && owner.isCurrentAgent();
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    const result = await owner.runtimeConfig.runExternalMutation(
      (client) => {
        if (client !== params.client) {
          throw new Error(t("modelProviders.requestFailed"));
        }
        const target = { provider: params.provider, agentId: params.agentId };
        return params.apiKey === null
          ? client.request<{ warning?: string }>("models.authLogout", {
              ...target,
              credentialType: "api_key",
            })
          : client.request<{ warning?: string }>("models.authSetApiKey", {
              ...target,
              apiKey: params.apiKey,
            });
      },
      { canDispatch: () => isCurrent() && owner.canMutate() },
    );
    if (!isCurrent()) {
      return { ok: false };
    }
    if (!result.ok) {
      owner.setMessage({ kind: "error", text: result.error });
      return { ok: false };
    }
    const warnings = result.value.warning ? [result.value.warning] : [];
    if (!result.refresh.ok) {
      warnings.push(result.refresh.error);
    } else {
      try {
        const warning = await owner.refreshProviders();
        if (warning) {
          warnings.push(warning);
        }
      } catch (error) {
        warnings.push(modelProviderErrorMessage(error));
      }
    }
    if (!isCurrent()) {
      return { ok: false };
    }
    const warning = warnings.length > 0 ? warnings.join(" ") : null;
    owner.setMessage({ kind: "success", text: params.success, ...(warning ? { warning } : {}) });
    return { ok: true, agentEpoch: owner.agentEpoch, warning };
  } finally {
    if (isCurrent()) {
      owner.setBusy(false);
    }
  }
}

export function modelProviderApiKeySuccess(
  action: "edit" | "add",
  apiKey: string | null,
  provider: string,
): string {
  return t(
    action === "add"
      ? "modelProviders.add.saved"
      : apiKey === null
        ? "modelProviders.apiKey.removed"
        : "modelProviders.apiKey.saved",
    { provider },
  );
}
