import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

function resolveConfigApiKey(cfg: OpenClawConfig): string {
  return cfg.tools?.qveris?.apiKey?.trim() ?? "";
}

function resolveEnvApiKey(): string {
  return process.env.QVERIS_API_KEY?.trim() ?? "";
}

export async function promptQverisConfig(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const configApiKey = resolveConfigApiKey(cfg);
  const envApiKey = resolveEnvApiKey();
  const hasAnyApiKey = Boolean(configApiKey || envApiKey);
  const currentlyEnabled = cfg.tools?.qveris?.enabled ?? hasAnyApiKey;

  await prompter.note(
    [
      "QVeris enables dynamic tool search/execution across domains like finance and research.",
      "Web search via QVeris is configured separately in the web search step.",
      "Docs: https://qveris.ai",
    ].join("\n"),
    "QVeris",
  );

  const enableQveris = await prompter.confirm({
    message: "Enable QVeris tool search?",
    initialValue: currentlyEnabled,
  });

  if (!enableQveris) {
    return {
      ...cfg,
      tools: {
        ...cfg.tools,
        qveris: {
          ...cfg.tools?.qveris,
          enabled: false,
        },
      },
    };
  }

  const enteredApiKey = (
    await prompter.text({
      message: configApiKey
        ? "QVeris API key (leave blank to keep current key)"
        : "QVeris API key (leave blank to rely on QVERIS_API_KEY env var)",
      placeholder: "qv_...",
      validate: (value) => {
        const trimmed = value.trim();
        if (trimmed) {
          return undefined;
        }
        if (configApiKey || envApiKey) {
          return undefined;
        }
        return "API key required (or set QVERIS_API_KEY in gateway env)";
      },
    })
  ).trim();

  const nextApiKey = enteredApiKey || configApiKey;
  let nextCfg: OpenClawConfig = {
    ...cfg,
    tools: {
      ...cfg.tools,
      qveris: {
        ...cfg.tools?.qveris,
        enabled: true,
        ...(nextApiKey ? { apiKey: nextApiKey } : {}),
      },
    },
  };

  if (!nextApiKey && !envApiKey) {
    await prompter.note(
      [
        "No QVeris API key is configured yet.",
        "Set QVERIS_API_KEY in the gateway environment to activate QVeris at runtime.",
      ].join("\n"),
      "QVeris API key",
    );
  }

  return nextCfg;
}
