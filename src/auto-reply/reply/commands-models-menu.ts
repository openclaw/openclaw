import { resolveSafeProviderId } from "../../agents/failover/user-copy.js";
import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import {
  CLAUDE_CLI_SETUP_GUIDANCE,
  resolveModelRuntimeRoute,
} from "../../shared/model-runtime-route.js";
import { formatProviderLoginCommand } from "../../shared/provider-login-command.js";

const CUSTOM_MODEL_SETUP_GUIDANCE =
  "Set up this connection with the custom-provider guide: https://docs.openclaw.ai/concepts/model-providers/custom-providers";
const MODEL_PROVIDER_ROUTE_DETAILS = {
  claudeCli:
    "Claude CLI runs through Claude Code using its native login or a selected saved account. An explicitly selected API-key account has separate API billing; CLI does not mean free or subscription-only.",
  anthropicConfigured:
    "Anthropic models can use the API or Claude CLI. Check each model's route label and selected account: API-key usage is billed separately from a Claude subscription.",
};

export type ModelsProviderMenu = { available: number; notice: string };
export type ModelReadiness = Pick<
  ModelAuthAvailabilityEvaluation,
  "availability" | "unavailableReason" | "runtimeAuth"
> & {
  runtimeId?: string;
};
export type ModelsMenu = {
  modelNames: ReadonlyMap<string, string>;
  byProvider: ReadonlyMap<string, ModelsProviderMenu>;
  // Optional so plugin-constructed menus with the original two-field shape
  // keep compiling and simply never produce a selection block.
  modelReadiness?: ReadonlyMap<string, ModelReadiness>;
  loginProviders?: ReadonlySet<string>;
  providerLogins?: ReadonlyMap<string, ModelProviderLogin>;
};

/** The single resolved login route for a provider, when one exists. */
export type ModelProviderLogin = {
  methodId: string;
  label: string;
  /** Channel-login mode of the resolved route ("secret"/"setup" = key entry). */
  mode?: string;
};

export type ModelSelectionAuthBlock = {
  label: string;
  recovery: string;
  notice: string;
  /** A chat `/login <provider>` route exists and may be offered as a button. */
  loginSupported: boolean;
};

function describeUnavailableModel(params: {
  provider: string;
  state: ModelReadiness;
  route: ReturnType<typeof resolveModelRuntimeRoute>;
  loginSupported: boolean;
  login?: ModelProviderLogin;
  pending?: boolean;
  agentId?: string;
}): { label: string; recovery: string } {
  const { state } = params;
  const loginCommand = formatProviderLoginCommand(params.provider);
  const apiKeyLogin = params.login?.methodId === "api-key" || params.login?.mode === "secret";
  const safeProvider = resolveSafeProviderId(params.provider);
  const agentFlag = params.agentId ? ` --agent ${params.agentId}` : "";
  const apiKeyRecovery = (verb: "Add" | "Update") =>
    safeProvider
      ? `${verb} the API key in Control UI → Models → Connect provider, or run \`openclaw models auth login --provider ${safeProvider}${agentFlag}\`.`
      : `${verb} the API key in Control UI → Models → Connect provider.`;
  if (state.runtimeAuth?.source === "native" && state.availability === undefined) {
    return params.pending
      ? {
          label: "Checking native agent",
          recovery: "Run /models again when discovery finishes.",
        }
      : {
          label: "Connection not confirmed",
          recovery: "Check the native app on the Gateway host, then run /models again.",
        };
  }
  switch (state.unavailableReason) {
    case "missing-auth":
      return {
        label: "Sign-in needed",
        recovery:
          params.route === "claudeCli"
            ? CLAUDE_CLI_SETUP_GUIDANCE
            : apiKeyLogin
              ? apiKeyRecovery("Add")
              : params.loginSupported
                ? `Connect with ${loginCommand}.`
                : CUSTOM_MODEL_SETUP_GUIDANCE,
      };
    case "auth-failed":
      return {
        label: "Sign-in failed",
        recovery: apiKeyLogin
          ? apiKeyRecovery("Update")
          : params.loginSupported
            ? `Sign in again with ${loginCommand}.`
            : CUSTOM_MODEL_SETUP_GUIDANCE,
      };
    case "cooldown":
      return {
        label: "Temporarily unavailable",
        recovery: "Try again later or choose another model.",
      };
    default:
      return state.availability === false
        ? { label: "Unavailable", recovery: "Run /models again or choose another model." }
        : {
            label: "Connection not confirmed",
            recovery: params.loginSupported
              ? `Connect with ${loginCommand}, or choose another model.`
              : CUSTOM_MODEL_SETUP_GUIDANCE,
          };
  }
}

/**
 * Explains why a picker selection must not be applied yet: the provider has
 * no working sign-in, so applying the model would strand the chat on a model
 * that can only fail authentication. Returns undefined when the selection may
 * proceed (ready, unconfirmed, or only temporarily cooling down).
 */
export function resolveModelSelectionAuthBlock(params: {
  menu?: ModelsMenu;
  provider: string;
  model: string;
  /** Chat-bound agent, so shell recovery targets the same credential store. */
  agentId?: string;
}): ModelSelectionAuthBlock | undefined {
  // Old-shape plugin-constructed menus may lack readiness; never block on absence.
  // Block missing-auth/auth-failed whether availability is a definitive false
  // or undefined: undefined + a reason is only produced when no credential
  // evidence exists at all (no config, env, or profile). Unprobed/local
  // evaluations carry no reason, and an unobserved native runtime is only
  // "connection not confirmed", so neither blocks.
  const state = params.menu?.modelReadiness?.get(`${params.provider}/${params.model}`);
  if (
    !state ||
    state.availability === true ||
    (state.unavailableReason !== "missing-auth" && state.unavailableReason !== "auth-failed")
  ) {
    return undefined;
  }
  if (state.availability === undefined && state.runtimeAuth?.source === "native") {
    return undefined;
  }
  const route = resolveModelRuntimeRoute(params.provider, state.runtimeId);
  const loginSupported =
    params.menu?.loginProviders?.has(params.provider) === true && route !== "claudeCli";
  const { label, recovery } = describeUnavailableModel({
    provider: params.provider,
    state,
    route,
    loginSupported,
    login: params.menu?.providerLogins?.get(params.provider),
    agentId: params.agentId,
  });
  return { label, recovery, notice: `${params.provider}: ${label}. ${recovery}`, loginSupported };
}

export function buildModelsMenu(data: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  modelNames: ReadonlyMap<string, string>;
  modelAvailability: ReadonlyMap<string, ModelReadiness>;
  loginProviders: ReadonlySet<string>;
  providerLogins?: ReadonlyMap<string, ModelProviderLogin>;
  pendingProviders?: readonly string[];
}): ModelsMenu {
  const modelNames = new Map(data.modelNames);
  const byProvider = new Map<string, ModelsProviderMenu>();
  for (const [id, models] of data.byProvider) {
    const notices = new Set<string>();
    const providerRoute = resolveModelRuntimeRoute(id);
    if (providerRoute === "claudeCli" || providerRoute === "anthropicConfigured") {
      notices.add(MODEL_PROVIDER_ROUTE_DETAILS[providerRoute]);
    }
    let available = 0;
    const loginSupported = data.loginProviders.has(id);
    const login = data.providerLogins?.get(id);
    const pending = data.pendingProviders?.includes(id) === true;
    for (const model of models) {
      const key = `${id}/${model}`;
      const state = data.modelAvailability.get(key)!;
      const route = resolveModelRuntimeRoute(id, state.runtimeId);
      const routeLabel =
        route === "claudeCli" ? "Claude CLI" : route === "anthropicApi" ? "API" : "";
      if (routeLabel) {
        modelNames.set(key, `${routeLabel} · ${data.modelNames.get(key) ?? model}`);
      }
      if (state.availability === true) {
        available += 1;
        continue;
      }
      const { label, recovery } = describeUnavailableModel({
        provider: id,
        state,
        route,
        loginSupported,
        login,
        pending,
      });
      modelNames.set(key, `${label} — ${modelNames.get(key) ?? model}`);
      notices.add(`${id}: ${label}. ${recovery}`);
    }
    byProvider.set(id, { available, notice: [...notices].join("\n") });
  }
  return {
    modelNames,
    byProvider,
    modelReadiness: data.modelAvailability,
    loginProviders: data.loginProviders,
    providerLogins: data.providerLogins ?? new Map(),
  };
}
