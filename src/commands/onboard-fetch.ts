import type { FetchProvider } from "../agents/tools/web-fetch.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { isFirecrawlAuthenticated, runFirecrawlOAuth } from "./onboard-search.js";

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
      hint: firecrawlReady
        ? "Already authenticated · recommended"
        : "Recommended · free 10,000 credits · search + scrape",
    },
    {
      value: "scrapingbee",
      label: "ScrapingBee",
      hint: "Requires API key · JS rendering support",
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

export async function setupFetch(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const firecrawlReady = isFirecrawlAuthenticated(config);
  const existingProvider = config.tools?.web?.fetch?.provider;

  await prompter.note(
    [
      "Web scraping lets your agent extract content from URLs.",
      "Choose a provider for the web_fetch tool.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web scraping",
  );

  const options = buildFetchProviderOptions(config);

  // Default to Firecrawl if already authenticated, otherwise firecrawl (top pick).
  const defaultProvider: FetchProvider =
    existingProvider === "firecrawl" ||
    existingProvider === "scrapingbee" ||
    existingProvider === "readability"
      ? existingProvider
      : "firecrawl";

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

  // Firecrawl selected but not authenticated — run OAuth to authenticate.
  if (choice === "firecrawl" && !firecrawlReady) {
    return runFirecrawlOAuth(config, runtime, prompter);
  }

  // ScrapingBee selected — check env var or prompt for API key.
  if (choice === "scrapingbee") {
    const envKey = process.env.SCRAPINGBEE_API_KEY?.trim();
    const existingKey =
      typeof config.tools?.web?.fetch?.scrapingbee?.apiKey === "string"
        ? config.tools.web.fetch.scrapingbee.apiKey
        : undefined;
    const hasKey = !!(envKey || existingKey);

    if (!hasKey) {
      const keyInput = await prompter.text({
        message: "ScrapingBee API key",
        placeholder: "Paste your key or set SCRAPINGBEE_API_KEY env var",
      });
      const key = keyInput?.trim() ?? "";
      if (!key) {
        await prompter.note("No API key provided. Falling back to Readability.", "Web scraping");
        return applyFetchProvider(config, "readability");
      }
      return {
        ...config,
        tools: {
          ...config.tools,
          web: {
            ...config.tools?.web,
            fetch: {
              ...config.tools?.web?.fetch,
              provider: "scrapingbee" as const,
              scrapingbee: {
                ...config.tools?.web?.fetch?.scrapingbee,
                apiKey: key,
              },
            },
          },
        },
      };
    }
  }

  return applyFetchProvider(config, choice);
}
