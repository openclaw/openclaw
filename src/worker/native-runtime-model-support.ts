import { createApiRegistry } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";

const registry = createApiRegistry();
registerBuiltInApiProviders(registry);
const supportedApis = new Set(registry.getApiProviders().map(({ api }) => api));

/** Explains when a model cannot run without ambient provider state. */
export function nativeRuntimeModelUnsupportedReason(
  api: string,
  credential: string,
): string | undefined {
  if (!supportedApis.has(api)) {
    return `Unsupported native runtime API: ${api}`;
  }
  if (api === "azure-openai-responses") {
    return "Native runtime does not support ambient-configured Azure API adapters";
  }
  if (
    api === "google-vertex" &&
    (credential.trim() === "gcp-vertex-credentials" || /^<[^>]+>$/.test(credential.trim()))
  ) {
    return "Native runtime Vertex requires an explicit API key, not ambient ADC";
  }
  return undefined;
}
