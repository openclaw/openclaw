/**
 * Compatibility subpath for provider auth login helpers.
 * Prefer provider auth hooks for provider-owned login commands.
 */

import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type ProviderAuthLoginRuntime = typeof import("./provider-auth-login.runtime.js");

const loadProviderAuthLoginRuntime = createLazyRuntimeModule(
  () => import("./provider-auth-login.runtime.js"),
);
const bindProviderAuthLoginRuntime = createLazyRuntimeMethodBinder(loadProviderAuthLoginRuntime);

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "./provider-auth-login.runtime.js";

/** Runs provider auth login through the existing models-auth persistence flow. */
export const runModelsAuthLoginFlow: ProviderAuthLoginRuntime["runModelsAuthLoginFlow"] =
  bindProviderAuthLoginRuntime((runtime) => runtime.runModelsAuthLoginFlow);
/** @deprecated GitHub Copilot provider-owned login helper; use provider auth hooks instead. */
export const githubCopilotLoginCommand: ProviderAuthLoginRuntime["githubCopilotLoginCommand"] =
  bindProviderAuthLoginRuntime((runtime) => runtime.githubCopilotLoginCommand);
/** @deprecated Chutes provider-owned login helper; use provider auth hooks instead. */
export const loginChutes: ProviderAuthLoginRuntime["loginChutes"] = bindProviderAuthLoginRuntime(
  (runtime) => runtime.loginChutes,
);
/** @deprecated OpenAI Codex provider-owned login helper; use provider auth hooks instead. */
export const loginOpenAICodexOAuth: ProviderAuthLoginRuntime["loginOpenAICodexOAuth"] =
  bindProviderAuthLoginRuntime((runtime) => runtime.loginOpenAICodexOAuth);
