// Public runtime auth helpers for provider plugins.

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  requireApiKey,
  resolveApiKeyForProvider,
  resolveAwsSdkEnvVarName,
} from "../agents/model-auth.js";
