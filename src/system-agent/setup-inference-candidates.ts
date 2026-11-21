import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { stageCodexCandidate } from "./setup-inference-codex.js";
import {
  type StageContext,
  type StagedCandidate,
  type StageFailure,
  parseInferenceRef,
  resolveSetupModel,
  parseProviderAutoSetupChoiceId,
  parseSavedAuthSetupProfileId,
  validateSetupModelTarget,
} from "./setup-inference-core.js";
import {
  stageProviderAuthCandidate,
  stageProviderAutoCandidate,
  stageSavedAuthCandidate,
} from "./setup-inference-credentials.js";

export async function stageSetupInferenceCandidate(
  ctx: StageContext,
): Promise<StagedCandidate | StageFailure> {
  const { params, cfg } = ctx;
  if (params.kind.startsWith("saved-auth:")) {
    const profileId = parseSavedAuthSetupProfileId(params.kind);
    if (!profileId) {
      return { error: "Invalid saved sign-in choice. Open Model Setup and choose again." };
    }
    return await stageSavedAuthCandidate(ctx, profileId);
  }
  const choiceId = parseProviderAutoSetupChoiceId(params.kind);
  const hasProviderTarget =
    choiceId ||
    params.kind === "existing-model" ||
    params.kind === "provider-auth" ||
    params.kind === "api-key";
  const roleError = hasProviderTarget
    ? undefined
    : validateSetupModelTarget(undefined, params.modelTarget);
  if (roleError) {
    return roleError;
  }
  if (choiceId) {
    return await stageProviderAutoCandidate(ctx, choiceId);
  }
  switch (params.kind) {
    case "existing-model": {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(
        cfg,
        params.agentId,
        params.modelTarget ? { modelTarget: params.modelTarget } : {},
        ctx.snapshot,
      );
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const routeRoleError = validateSetupModelTarget(route.modelTarget, params.modelTarget);
      if (routeRoleError) {
        return routeRoleError;
      }
      const requested = params.modelRef?.trim();
      if (requested && normalizeAgentModelRefForConfig(requested) !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requested} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return {
        modelRef: route.modelLabel,
        ...(route.modelTarget ? { modelTarget: route.modelTarget } : {}),
        config: cfg,
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "api-key":
      return await stageProviderAuthCandidate(ctx, false);
    case "provider-auth":
      return await stageProviderAuthCandidate(ctx, true);
    case "codex-cli":
    case "claude-cli":
    case "gemini-cli":
    case "openai-api-key":
    case "anthropic-api-key": {
      const defaults = {
        "codex-cli": CODEX_APP_SERVER_DEFAULT_MODEL_REF,
        "claude-cli": CLAUDE_CLI_DEFAULT_MODEL_REF,
        "gemini-cli": GEMINI_CLI_DEFAULT_MODEL_REF,
        "openai-api-key": OPENAI_API_DEFAULT_MODEL_REF,
        "anthropic-api-key": ANTHROPIC_API_DEFAULT_MODEL_REF,
      };
      const defaultModel = defaults[params.kind];
      const modelRef = resolveSetupModel({
        label: params.kind,
        providerId: parseInferenceRef(defaultModel).provider,
        defaultModel,
        modelRef: params.modelRef,
      });
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      if (params.kind === "codex-cli") {
        return await stageCodexCandidate(ctx, modelRef);
      }
      if (params.kind === "claude-cli") {
        const ref = parseInferenceRef(modelRef);
        const provider =
          resolveCliRuntimeCanonicalProvider({
            runtime: ref.provider,
            config: cfg,
            env: process.env,
            includeSetupRegistry: true,
          }) ?? ref.provider;
        return { modelRef: `${provider}/${ref.model}`, agentRuntimeId: "claude-cli", config: cfg };
      }
      return {
        modelRef,
        ...(params.kind === "gemini-cli" ? {} : { agentRuntimeId: "openclaw" }),
        config: cfg,
      };
    }
    default:
      return { error: `Unknown inference choice "${params.kind}".` };
  }
}
