import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfigSnapshot,
} from "./inference-route.js";
import {
  type ActivateSetupInferenceDeps,
  type CompleteSetupInferenceResult,
  invalidSetupConfigError,
  redactSetupInferenceError,
} from "./setup-inference-core.js";
import { runSetupInferenceTurn, type SetupInferenceRequestParams } from "./setup-inference-turn.js";

/** Run one tool-free completion through the configured setup inference route. */
export async function completeSetupInference(
  params: SetupInferenceRequestParams & { prompt: string },
): Promise<CompleteSetupInferenceResult> {
  const readSnapshot =
    params.deps?.readConfigFileSnapshot ??
    (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (!snapshot.exists) {
    return { ok: false, status: "unavailable", error: "No OpenClaw config exists." };
  }
  if (!snapshot.valid) {
    return { ok: false, status: "format", error: invalidSetupConfigError(snapshot) };
  }
  return await completeSetupInferenceConfig({
    ...params,
    config: snapshot.runtimeConfig ?? snapshot.config,
    configSnapshot: snapshot,
  });
}

/** Config-injected variant used by setup clients and live provider tests. */
export async function completeSetupInferenceConfig(
  params: SetupInferenceRequestParams & {
    config: OpenClawConfig;
    configSnapshot?: SystemAgentConfigSnapshot;
    prompt: string;
  },
): Promise<CompleteSetupInferenceResult> {
  const deps: ActivateSetupInferenceDeps = {
    ...params.deps,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  };
  const route = await resolveSystemAgentConfiguredRouteFromConfig(
    params.config,
    params.agentId,
    {
      loadAuthProfileStoreForRuntimeAsync: deps.loadAuthProfileStoreForRuntimeAsync,
      modelTarget: params.modelTarget,
    },
    params.configSnapshot,
  );
  if (!route) {
    return {
      ok: false,
      status: "unavailable",
      error:
        params.modelTarget === "primary"
          ? "No primary model is configured for this agent. Choose one in Model Setup, then retry."
          : "No agent model is configured.",
    };
  }
  const turn = await runSetupInferenceTurn({
    route,
    prompt: params.prompt,
    deps,
    requireExecutionOwner: false,
    runtime: params.runtime,
  });
  if (!turn.ok) {
    return { ...turn, error: await redactSetupInferenceError(turn.error) };
  }
  return {
    ok: true,
    modelRef: route.modelLabel,
    latencyMs: turn.latencyMs,
    text: turn.text,
  };
}
