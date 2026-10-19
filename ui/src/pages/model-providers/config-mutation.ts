import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { FastMode, ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import {
  modelSettingPrimary,
  modelSettingFallbacks,
  modelSettingPatch,
  withModelSettingPrimary,
} from "../../lib/model-setting.ts";
import type { DefaultModelSelection, DefaultsDraft, ModelBehaviorConfig } from "./data.ts";

function replaceFirstFallback(fallbacks: string[], model: string | null): string[] {
  return model ? [model, ...fallbacks.slice(1).filter((fallback) => fallback !== model)] : [];
}

export function modelDefaultsActions(
  getDefaults: () => DefaultModelSelection,
  stageDefaults: (patch: Partial<DefaultModelSelection & ModelBehaviorConfig>) => void,
) {
  return {
    onPrimaryChange: (model: string) => {
      stageDefaults({
        primary: model,
        fallbacks: getDefaults().fallbacks.filter((fallback) => fallback !== model),
      });
    },
    onFallbackChange: (model: string | null) => {
      stageDefaults({
        fallbacks: replaceFirstFallback(getDefaults().fallbacks, model),
      });
    },
    onUtilityChange: (model: string | null) =>
      stageDefaults({ utilityModel: withModelSettingPrimary(getDefaults().utilityModel, model) }),
    onUtilityFallbackChange: (model: string | null) => {
      const current = getDefaults().utilityModel;
      const primary = modelSettingPrimary(current);
      stageDefaults({
        utilityModel: {
          ...(primary !== undefined ? { primary } : {}),
          fallbacks: replaceFirstFallback(modelSettingFallbacks(current), model),
        },
      });
    },
    onDecisionChange: (model: string | null) => stageDefaults({ decisionModel: model }),
    onThinkingChange: (level: string) =>
      stageDefaults({ thinkingLevel: level, thinkingOverridden: true }),
    onThinkingReset: () => stageDefaults({ thinkingLevel: undefined, thinkingOverridden: false }),
    onFastModeChange: (mode: FastMode) =>
      stageDefaults({ fastMode: mode, fastModeOverridden: true }),
    onFastModeReset: () => stageDefaults({ fastMode: undefined, fastModeOverridden: false }),
  };
}

export function readModelBehaviorConfig(
  agentsDefaults: Record<string, unknown> | null,
): ModelBehaviorConfig {
  const thinkingValue = agentsDefaults?.thinkingDefault;
  const fastValue = agentsDefaults?.fastModeDefault;
  return {
    thinkingLevel: typeof thinkingValue === "string" ? thinkingValue : undefined,
    thinkingOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "thinkingDefault"),
    fastMode:
      fastValue === "auto" || fastValue === "ultrafast" || typeof fastValue === "boolean"
        ? fastValue
        : undefined,
    fastModeOverridden: agentsDefaults !== null && Object.hasOwn(agentsDefaults, "fastModeDefault"),
  };
}

/**
 * Removing or reordering fallbacks shrinks a config array; the gateway's
 * destructive-array guard rejects such merge patches unless the exact path is
 * confirmed via replacePaths.
 */
const DEFAULT_MODELS_REPLACE_PATHS = [
  "agents.defaults.model.fallbacks",
  "agents.defaults.utilityModel.fallbacks",
];

function buildDefaultsPatch(
  params: Omit<DefaultModelSelection, "fallbacks"> &
    ModelBehaviorConfig & {
      fallbacks: readonly string[];
    },
) {
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
        utilityModel: modelSettingPatch(params.utilityModel),
        ...(params.decisionModel !== undefined ? { decisionModel: params.decisionModel } : {}),
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
  kind: "success" | "warning" | "error";
  text: string;
  warning?: string;
};

export function modelProviderConfigBusy(context: ApplicationContext): boolean {
  const runtimeState = context.runtimeConfig.state;
  const update = context.overlays.snapshot;
  return (
    runtimeState.configLoading ||
    runtimeState.configSaving ||
    runtimeState.configApplying ||
    update.updateRunning ||
    update.updateReconciliationPending
  );
}

type ModelProviderConfigMutation = {
  raw: Record<string, unknown>;
  note: string;
  replacePaths?: string[];
};

type ModelProviderConfigMutationOwner = {
  runtimeConfig: RuntimeConfigCapability;
  isCurrentClient: () => boolean;
  isCurrentAgent: () => boolean;
  setBusy: (busy: boolean) => void;
  setMessage: (message: ModelProviderRowMessage | null) => void;
};

export function runModelProviderDefaultsMutation(
  context: ApplicationContext,
  gateway: Pick<GatewayPageBinding, "capture" | "isCurrent">,
  owner: Omit<ModelProviderConfigMutationOwner, "runtimeConfig" | "isCurrentClient"> & {
    defaults: DefaultsDraft;
    busy: boolean;
  },
): Promise<boolean | null> {
  const scope = gateway.capture();
  // Global defaults remain editable when the configured roster is empty.
  if (
    !scope ||
    owner.busy ||
    modelProviderConfigMutationBlockedReason(context) ||
    modelProviderConfigBusy(context)
  ) {
    return Promise.resolve(null);
  }
  return runModelProviderConfigMutation(
    {
      runtimeConfig: context.runtimeConfig,
      isCurrentClient: () => gateway.isCurrent(scope),
      isCurrentAgent: owner.isCurrentAgent,
      setBusy: owner.setBusy,
      setMessage: owner.setMessage,
    },
    {
      raw: buildDefaultsPatch(owner.defaults),
      note: t("modelProviders.notes.defaultModel"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    },
  );
}

export function modelProviderConfigMutationBlockedReason(
  context: Pick<ApplicationContext, "gateway" | "runtimeConfig">,
): string | null {
  const snapshot = context.gateway.snapshot;
  if (snapshot.phase !== "connected") {
    return t("modelProviders.readOnly.disconnected");
  }
  if (context.runtimeConfig.canPatch !== true) {
    return t("modelProviders.readOnly.adminRequired");
  }
  const config = context.runtimeConfig.state;
  if (!snapshot.client || config.client !== snapshot.client || !currentConfigObject(config)) {
    return t("modelProviders.configUnavailable");
  }
  return null;
}

export function modelProviderErrorMessage(error: unknown): string {
  return formatUiError(error, t("modelProviders.requestFailed"));
}

export async function modelProviderMutationWarnings(
  result: {
    value: { warning?: string };
    refresh: { ok: true } | { ok: false; error: string };
  },
  refreshProviders: () => Promise<string | null | undefined>,
): Promise<string | null> {
  const warnings = result.value.warning ? [result.value.warning] : [];
  if (!result.refresh.ok) {
    warnings.push(result.refresh.error);
  } else {
    try {
      const warning = await refreshProviders();
      if (warning) {
        warnings.push(warning);
      }
    } catch (error) {
      warnings.push(modelProviderErrorMessage(error));
    }
  }
  return warnings.length ? warnings.join(" ") : null;
}

/**
 * The config owner adopts the committed snapshot and reconciles application.
 * Saving ends at its acknowledgement, not at a second read or provider discovery.
 * Null keeps an undispatched or superseded draft; false reports a settled failure.
 */
export async function runModelProviderConfigMutation(
  owner: ModelProviderConfigMutationOwner,
  params: ModelProviderConfigMutation,
): Promise<boolean | null> {
  const { runtimeConfig } = owner;
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    await runtimeConfig.ensureLoaded();
    if (!owner.isCurrentClient()) {
      return null;
    }
    const patched = await runtimeConfig.patch({
      raw: params.raw,
      note: params.note,
      ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
    });
    if (!owner.isCurrentClient()) {
      return null;
    }
    // No dispatched write or recorded failure leaves the caller's draft intact.
    if (!patched && !runtimeConfig.state.lastError) {
      return null;
    }
    if (!patched && owner.isCurrentAgent()) {
      owner.setMessage({
        kind: "error",
        text: runtimeConfig.state.lastError ?? t("modelProviders.configUnavailable"),
      });
    }
    return patched;
  } catch (error) {
    if (!owner.isCurrentClient()) {
      return null;
    }
    if (owner.isCurrentAgent()) {
      owner.setMessage({ kind: "error", text: modelProviderErrorMessage(error) });
    }
    return false;
  } finally {
    if (owner.isCurrentClient() && owner.isCurrentAgent()) {
      owner.setBusy(false);
    }
  }
}

/** Credential writes share config serialization and retain acknowledged success during refresh. */
export async function runModelProviderApiKeyMutation(
  owner: ModelProviderConfigMutationOwner & {
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
): Promise<{ ok: false } | { ok: true; warning: string | null }> {
  const isCurrent = () => owner.isCurrentClient() && owner.isCurrentAgent();
  owner.setBusy(true);
  owner.setMessage(null);
  try {
    const result = await owner.runtimeConfig.runExternalMutation(
      async (client) => {
        if (client !== params.client) {
          throw new Error(t("modelProviders.requestFailed"));
        }
        const target = { provider: params.provider, agentId: params.agentId };
        const receipt = await (params.apiKey === null
          ? client.request<{ warning?: string }>("models.authLogout", {
              ...target,
              credentialType: "api_key",
            })
          : client.request<{ warning?: string }>("models.authSetApiKey", {
              ...target,
              apiKey: params.apiKey,
            }));
        invalidateModelAuthStatusRequests(client);
        return receipt;
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
    const warning = await modelProviderMutationWarnings(result, () => owner.refreshProviders());
    if (!isCurrent()) {
      return { ok: false };
    }
    owner.setMessage({ kind: "success", text: params.success, ...(warning ? { warning } : {}) });
    return { ok: true, warning };
  } finally {
    if (isCurrent()) {
      owner.setBusy(false);
    }
  }
}
