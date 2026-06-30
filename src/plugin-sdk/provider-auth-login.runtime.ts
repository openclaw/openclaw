/** Provider auth login helpers for bundled channel auth recovery. */
export {
  runModelsAuthLoginFlow,
  type ModelsAuthLoginFlowOptions,
  type ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";

/** @deprecated Provider-owned login helpers; use provider auth hooks instead. */
export { loginChutes } from "../commands/chutes-oauth.js";
/** @deprecated Provider-owned login helpers; use provider auth hooks instead. */
export { loginOpenAICodexOAuth } from "../plugins/provider-openai-chatgpt-oauth.js";
/** @deprecated Provider-owned login helpers; use provider auth hooks instead. */
export { githubCopilotLoginCommand } from "./github-copilot-login.js";
