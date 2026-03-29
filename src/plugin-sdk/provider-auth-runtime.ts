// Public runtime auth helpers for provider plugins.

export { resolveEnvApiKey } from "../agents/model-auth-env.js";
export {
  requireApiKey,
  resolveAwsSdkEnvVarName,
  type ResolvedProviderAuth,
} from "../agents/model-auth-runtime-shared.js";

type ResolveApiKeyForProvider = typeof import("../agents/model-auth.js").resolveApiKeyForProvider;

export async function resolveApiKeyForProvider(
  params: Parameters<ResolveApiKeyForProvider>[0],
): Promise<Awaited<ReturnType<ResolveApiKeyForProvider>>> {
  const { resolveApiKeyForProvider } = await import("../agents/model-auth.js");
  return resolveApiKeyForProvider(params);
}
