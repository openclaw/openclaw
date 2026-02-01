import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import {
  applyAuthProfileConfig,
  applyOllamaProviderConfig,
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_API_KEY,
  setOllamaApiKey,
} from "./onboard-auth.js";

const DEFAULT_OLLAMA_HOST = OLLAMA_BASE_URL.replace("/v1", "");

/** Check if Ollama is reachable at the given base URL (without /v1 suffix). */
async function checkOllamaReachable(host: string): Promise<boolean> {
  try {
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function applyAuthChoiceOllama(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "ollama") {
    return null;
  }

  let nextConfig = params.config;

  // Try auto-detecting Ollama at the default URL
  const defaultReachable = await checkOllamaReachable(DEFAULT_OLLAMA_HOST);

  let baseUrl = OLLAMA_BASE_URL;
  if (defaultReachable) {
    await params.prompter.note(
      `Ollama detected at ${DEFAULT_OLLAMA_HOST}`,
      "Ollama",
    );
  } else {
    await params.prompter.note(
      [
        "Ollama runs models locally or in the cloud.",
        "Make sure Ollama is installed and running: https://ollama.com",
      ].join("\n"),
      "Ollama",
    );

    const customUrl = await params.prompter.text({
      message: `Ollama not detected at default. Enter server URL:`,
      initialValue: DEFAULT_OLLAMA_HOST,
      validate: (value) => {
        if (!value?.trim()) return "URL is required";
        try {
          new URL(value.trim());
          return undefined;
        } catch {
          return "Invalid URL format";
        }
      },
    });
    // Append /v1 if not present for OpenAI-compatible endpoint
    const trimmedUrl = String(customUrl).trim().replace(/\/+$/, "");
    baseUrl = trimmedUrl.endsWith("/v1") ? trimmedUrl : `${trimmedUrl}/v1`;
  }

  // Store the placeholder API key to enable provider discovery
  await setOllamaApiKey(OLLAMA_DEFAULT_API_KEY, params.agentDir);

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "ollama:default",
    provider: "ollama",
    mode: "api_key",
  });

  nextConfig = applyOllamaProviderConfig(nextConfig, { baseUrl });

  await params.prompter.note(
    [
      "Ollama configured successfully.",
      "Models will be discovered automatically from your Ollama server.",
      "Use `ollama pull <model>` to download models, then `openclaw models list` to see them.",
    ].join("\n"),
    "Setup complete",
  );

  return { config: nextConfig };
}
