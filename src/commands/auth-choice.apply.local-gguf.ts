import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";

export async function applyAuthChoiceLocalGguf(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "local-gguf") {
    return null;
  }

  const folderPath = await params.prompter.text({
    message: "Path to GGUF models folder",
    validate: (value) => (value?.trim() ? undefined : "Must be a valid absolute path"),
  });

  if (typeof folderPath === "symbol") {
    throw new Error("Aborted");
  }

  const config = {
    ...params.config,
    models: {
      ...params.config.models,
      providers: {
        ...params.config.models?.providers,
        "local-gguf": {
          baseUrl: `file://${String(folderPath).trim()}`,
          api: "openai-completions" as const,
          models: [],
        },
      },
    },
  };

  return { config, agentModelOverride: undefined };
}
