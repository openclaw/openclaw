import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export const DEFAULT_QVERIS_WEB_SEARCH_TOOL_ID =
  "xiaosu.smartsearch.search.retrieve.v2.6c50f296_domestic";

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
      "When enabled here, web_search is also defaulted to QVeris smart search (xiaosu) to avoid requiring Brave API keys.",
      "Docs: https://qveris.ai",
    ].join("\n"),
    "QVeris",
  );

  const enableQveris = await prompter.confirm({
    message: "Enable QVeris tools and default web_search to QVeris?",
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
      web: {
        ...cfg.tools?.web,
        search: {
          ...cfg.tools?.web?.search,
          enabled: true,
          provider: "qveris",
          qveris: {
            ...cfg.tools?.web?.search?.qveris,
            toolId: DEFAULT_QVERIS_WEB_SEARCH_TOOL_ID,
          },
        },
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
