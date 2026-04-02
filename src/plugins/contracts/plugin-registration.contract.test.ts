import { describePluginRegistrationContract } from "../../../test/helpers/plugins/plugin-registration-contract.js";

type PluginRegistrationContractParams = Parameters<typeof describePluginRegistrationContract>[0];

const pluginRegistrationContractTests: PluginRegistrationContractParams[] = [
  {
    pluginId: "anthropic",
    providerIds: ["anthropic"],
    mediaUnderstandingProviderIds: ["anthropic"],
    cliBackendIds: ["claude-cli"],
    requireDescribeImages: true,
  },
  {
    pluginId: "brave",
    webSearchProviderIds: ["brave"],
  },
  {
    pluginId: "deepgram",
    mediaUnderstandingProviderIds: ["deepgram"],
  },
  {
    pluginId: "duckduckgo",
    webSearchProviderIds: ["duckduckgo"],
  },
  {
    pluginId: "elevenlabs",
    speechProviderIds: ["elevenlabs"],
    requireSpeechVoices: true,
  },
  {
    pluginId: "exa",
    webSearchProviderIds: ["exa"],
  },
  {
    pluginId: "fal",
    providerIds: ["fal"],
    imageGenerationProviderIds: ["fal"],
  },
  {
    pluginId: "firecrawl",
    webFetchProviderIds: ["firecrawl"],
    webSearchProviderIds: ["firecrawl"],
    toolNames: ["firecrawl_search", "firecrawl_scrape"],
  },
  {
    pluginId: "google",
    providerIds: ["google", "google-gemini-cli"],
    webSearchProviderIds: ["gemini"],
    mediaUnderstandingProviderIds: ["google"],
    imageGenerationProviderIds: ["google"],
    cliBackendIds: ["google-gemini-cli"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  {
    pluginId: "groq",
    mediaUnderstandingProviderIds: ["groq"],
  },
  {
    pluginId: "microsoft",
    speechProviderIds: ["microsoft"],
    requireSpeechVoices: true,
  },
  {
    pluginId: "minimax",
    providerIds: ["minimax", "minimax-portal"],
    mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
    imageGenerationProviderIds: ["minimax", "minimax-portal"],
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  {
    pluginId: "mistral",
    mediaUnderstandingProviderIds: ["mistral"],
  },
  {
    pluginId: "moonshot",
    providerIds: ["moonshot"],
    webSearchProviderIds: ["kimi"],
    mediaUnderstandingProviderIds: ["moonshot"],
    requireDescribeImages: true,
    manifestAuthChoice: {
      pluginId: "kimi",
      choiceId: "kimi-code-api-key",
      choiceLabel: "Kimi Code API key (subscription)",
      groupId: "moonshot",
      groupLabel: "Moonshot AI (Kimi K2.5)",
      groupHint: "Kimi K2.5",
    },
  },
  {
    pluginId: "openai",
    providerIds: ["openai", "openai-codex"],
    speechProviderIds: ["openai"],
    mediaUnderstandingProviderIds: ["openai", "openai-codex"],
    imageGenerationProviderIds: ["openai"],
    cliBackendIds: ["codex-cli"],
    requireSpeechVoices: true,
    requireDescribeImages: true,
    requireGenerateImage: true,
  },
  {
    pluginId: "openrouter",
    providerIds: ["openrouter"],
    mediaUnderstandingProviderIds: ["openrouter"],
    requireDescribeImages: true,
  },
  {
    pluginId: "perplexity",
    webSearchProviderIds: ["perplexity"],
  },
  {
    pluginId: "tavily",
    webSearchProviderIds: ["tavily"],
    toolNames: ["tavily_search", "tavily_extract"],
  },
  {
    pluginId: "xai",
    providerIds: ["xai"],
    webSearchProviderIds: ["grok"],
  },
  {
    pluginId: "zai",
    mediaUnderstandingProviderIds: ["zai"],
    requireDescribeImages: true,
  },
];

for (const params of pluginRegistrationContractTests) {
  describePluginRegistrationContract(params);
}
