import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

export async function applyAuthChoiceLocalApi(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "local-api") {
    return null;
  }

  const url = await params.prompter.text({
    message: "Local API Server URL",
    initialValue: "http://localhost:1234/v1",
    validate: (value) =>
      value?.trim().startsWith("http") ? undefined : "Must be a valid HTTP URL",
  });

  if (typeof url === "symbol") {
    throw new Error("Aborted");
  }

  const apiKey = await params.prompter.text({
    message: "API Key (optional)",
    initialValue: "none",
  });

  if (typeof apiKey === "symbol") {
    throw new Error("Aborted");
  }

  const config = {
    ...params.config,
    models: {
      ...params.config.models,
      providers: {
        ...params.config.models?.providers,
        "local-api": {
          baseUrl: String(url).trim(),
          apiKey: String(apiKey).trim() || "none",
          api: "openai-responses",
          models: [],
        },
      },
    },
  };

  return { config, agentModelOverride: undefined };
}
