// Public interactive auth/login helpers for provider plugins.

import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

type ProviderAuthLoginRuntime = typeof import("./provider-auth-login.runtime.js");

const loadProviderAuthLoginRuntime = createLazyRuntimeModule(
  () => import("./provider-auth-login.runtime.js"),
);
const bindProviderAuthLoginRuntime = createLazyRuntimeMethodBinder(loadProviderAuthLoginRuntime);

export const githubCopilotLoginCommand: ProviderAuthLoginRuntime["githubCopilotLoginCommand"] =
  bindProviderAuthLoginRuntime((runtime) => runtime.githubCopilotLoginCommand);
export const loginChutes: ProviderAuthLoginRuntime["loginChutes"] = bindProviderAuthLoginRuntime(
  (runtime) => runtime.loginChutes,
);
export const loginOpenAICodexOAuth: ProviderAuthLoginRuntime["loginOpenAICodexOAuth"] =
  bindProviderAuthLoginRuntime((runtime) => runtime.loginOpenAICodexOAuth);
