import type { ModelAuthAvailabilityEvaluation } from "../../agents/model-auth-availability.js";
import { resolveModelRuntimeRoute } from "../../shared/model-runtime-route.js";
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
};

export function buildModelsMenu(data: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  modelNames: ReadonlyMap<string, string>;
  modelAvailability: ReadonlyMap<string, ModelReadiness>;
  loginProviders: ReadonlySet<string>;
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
    const loginCommand = formatProviderLoginCommand(id);
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
      let label: string;
      let recovery: string;
      if (state.runtimeAuth?.source === "native" && state.availability === undefined) {
        label = pending ? "Checking native agent" : "Connection not confirmed";
        recovery = pending
          ? "Run /models again when discovery finishes."
          : "Check the native app on the Gateway host, then run /models again.";
      } else {
        switch (state.unavailableReason) {
          case "missing-auth":
            label = "Sign-in needed";
            recovery = loginSupported
              ? `Connect with ${loginCommand}.`
              : CUSTOM_MODEL_SETUP_GUIDANCE;
            break;
          case "auth-failed":
            label = "Sign-in failed";
            recovery = loginSupported
              ? `Sign in again with ${loginCommand}.`
              : CUSTOM_MODEL_SETUP_GUIDANCE;
            break;
          case "cooldown":
            label = "Temporarily unavailable";
            recovery = "Try again later or choose another model.";
            break;
          default:
            label = state.availability === false ? "Unavailable" : "Connection not confirmed";
            recovery =
              state.availability === false
                ? "Run /models again or choose another model."
                : loginSupported
                  ? `Connect with ${loginCommand}, or choose another model.`
                  : CUSTOM_MODEL_SETUP_GUIDANCE;
        }
      }
      modelNames.set(key, `${label} — ${modelNames.get(key) ?? model}`);
      notices.add(`${id}: ${label}. ${recovery}`);
    }
    byProvider.set(id, { available, notice: [...notices].join("\n") });
  }
  return { modelNames, byProvider };
}
