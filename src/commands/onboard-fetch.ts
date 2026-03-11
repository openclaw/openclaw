import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { isFirecrawlAuthenticated } from "./onboard-search.js";

export type FetchProvider = "readability" | "firecrawl";

type FetchProviderEntry = {
  value: FetchProvider;
  label: string;
  hint: string;
};

function buildFetchProviderOptions(config: OpenClawConfig): FetchProviderEntry[] {
  const firecrawlReady = isFirecrawlAuthenticated(config);
  return [
    {
      value: "firecrawl",
      label: "\uD83D\uDD25 Firecrawl",
      hint: firecrawlReady ? "Already authenticated · recommended" : "Requires Firecrawl API key",
    },
    {
      value: "readability",
      label: "Readability (built-in)",
      hint: "No dependencies · basic HTML extraction",
    },
  ];
}

function applyFetchProvider(config: OpenClawConfig, provider: FetchProvider): OpenClawConfig {
  return {
    ...config,
    tools: {
      ...config.tools,
      web: {
        ...config.tools?.web,
        fetch: {
          ...config.tools?.web?.fetch,
          provider,
        },
      },
    },
  };
}

export type SetupFetchOptions = {
  quickstartDefaults?: boolean;
};

export async function setupFetch(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  opts?: SetupFetchOptions,
): Promise<OpenClawConfig> {
  const firecrawlReady = isFirecrawlAuthenticated(config);
  const existingProvider = config.tools?.web?.fetch?.provider;

  // QuickStart: auto-select Firecrawl if authenticated, otherwise readability.
  if (opts?.quickstartDefaults) {
    if (existingProvider) {
      return config;
    }
    return applyFetchProvider(config, firecrawlReady ? "firecrawl" : "readability");
  }

  await prompter.note(
    [
      "Web scraping lets your agent extract content from URLs.",
      "Choose a provider for the web_fetch tool.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web scraping",
  );

  const options = buildFetchProviderOptions(config);

  // Default to Firecrawl if already authenticated, otherwise readability.
  const defaultProvider: FetchProvider =
    existingProvider === "firecrawl" || existingProvider === "readability"
      ? existingProvider
      : firecrawlReady
        ? "firecrawl"
        : "readability";

  type PickerValue = FetchProvider | "__skip__";
  const choice = await prompter.select<PickerValue>({
    message: "Scraping provider",
    options: [
      ...options,
      {
        value: "__skip__" as const,
        label: "Skip for now",
        hint: "Configure later with openclaw configure --section web",
      },
    ],
    initialValue: defaultProvider as PickerValue,
  });

  if (choice === "__skip__") {
    return config;
  }

  // Firecrawl selected but not authenticated — warn and fall back.
  if (choice === "firecrawl" && !firecrawlReady) {
    await prompter.note(
      [
        "Firecrawl requires an API key. Select Firecrawl as your search provider first",
        "to authenticate, or set FIRECRAWL_API_KEY in your environment.",
        "Falling back to Readability for now.",
      ].join("\n"),
      "Web scraping",
    );
    return applyFetchProvider(config, "readability");
  }

  return applyFetchProvider(config, choice);
}
