import { requireApiKey, resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { buildRemoteBaseUrlPolicy } from "./remote-http.js";
import { resolveMemorySecretInputString } from "./secret-input.js";
export async function resolveRemoteEmbeddingBearerClient(params) {
    const remote = params.options.remote;
    const remoteApiKey = resolveMemorySecretInputString({
        value: remote?.apiKey,
        path: "agents.*.memorySearch.remote.apiKey",
    });
    const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
    const providerConfig = params.options.config.models?.providers?.[params.provider];
    const apiKey = remoteApiKey
        ? remoteApiKey
        : requireApiKey(await resolveApiKeyForProvider({
            provider: params.provider,
            cfg: params.options.config,
            agentDir: params.options.agentDir,
        }), params.provider);
    const baseUrl = remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
    const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...headerOverrides,
    };
    return { baseUrl, headers, ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl) };
}
