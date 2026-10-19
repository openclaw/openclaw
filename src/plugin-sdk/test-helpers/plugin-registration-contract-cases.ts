import type { PluginRegistrationContractParams } from "./plugin-registration-contract.js";

type RegistrationSurfaces = Omit<PluginRegistrationContractParams, "pluginId">;

function registration<T extends RegistrationSurfaces>(
  pluginId: string,
  surfaces: T & Record<Exclude<keyof T, keyof RegistrationSurfaces>, never>,
) {
  return { pluginId, ...surfaces };
}

export const pluginRegistrationContractCases = {
  alibaba: registration("alibaba", { videoGenerationProviderIds: ["alibaba"] }),
  anthropic: registration("anthropic", {
    providerIds: ["anthropic"],
    mediaUnderstandingProviderIds: ["anthropic"],
    cliBackendIds: ["claude-cli"],
  }),
  brave: registration("brave", { webSearchProviderIds: ["brave"] }),
  byteplus: registration("byteplus", {
    providerIds: ["byteplus", "byteplus-plan"],
    videoGenerationProviderIds: ["byteplus"],
  }),
  comfy: registration("comfy", {
    providerIds: ["comfy"],
    imageGenerationProviderIds: ["comfy"],
    musicGenerationProviderIds: ["comfy"],
    videoGenerationProviderIds: ["comfy"],
  }),
  deepgram: registration("deepgram", { mediaUnderstandingProviderIds: ["deepgram"] }),
  duckduckgo: registration("duckduckgo", { webSearchProviderIds: ["duckduckgo"] }),
  elevenlabs: registration("elevenlabs", { speechProviderIds: ["elevenlabs"] }),
  exa: registration("exa", { webSearchProviderIds: ["exa"] }),
  fal: registration("fal", {
    providerIds: ["fal"],
    imageGenerationProviderIds: ["fal"],
    musicGenerationProviderIds: ["fal"],
    videoGenerationProviderIds: ["fal"],
  }),
  firecrawl: registration("firecrawl", {
    webFetchProviderIds: ["firecrawl"],
    webSearchProviderIds: ["firecrawl", "firecrawl-free"],
    toolNames: ["firecrawl_search", "firecrawl_scrape"],
  }),
  google: registration("google", {
    providerIds: ["google", "google-gemini-cli", "google-vertex"],
    webSearchProviderIds: ["gemini"],
    realtimeVoiceProviderIds: ["google"],
    speechProviderIds: ["google"],
    mediaUnderstandingProviderIds: ["google"],
    imageGenerationProviderIds: ["google"],
    videoGenerationProviderIds: ["google"],
  }),
  gradium: registration("gradium", { speechProviderIds: ["gradium"] }),
  groq: registration("groq", { mediaUnderstandingProviderIds: ["groq"] }),
  kie: registration("kie", { videoGenerationProviderIds: ["kie"] }),
  lmstudio: registration("lmstudio", { providerIds: ["lmstudio"] }),
  microsoft: registration("microsoft", { speechProviderIds: ["microsoft", "edge"] }),
  minimax: registration("minimax", {
    providerIds: ["minimax", "minimax-portal"],
    speechProviderIds: ["minimax"],
    mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
    imageGenerationProviderIds: ["minimax", "minimax-portal"],
    musicGenerationProviderIds: ["minimax", "minimax-portal"],
    videoGenerationProviderIds: ["minimax", "minimax-portal"],
    webSearchProviderIds: ["minimax"],
  }),
  mistral: registration("mistral", { mediaUnderstandingProviderIds: ["mistral"] }),
  moonshot: registration("moonshot", {
    providerIds: ["moonshot"],
    webSearchProviderIds: ["kimi"],
    mediaUnderstandingProviderIds: ["moonshot"],
    manifestAuthChoice: {
      pluginId: "kimi",
      choiceId: "kimi-code-api-key",
      choiceLabel: "Kimi Code API key (subscription)",
      groupId: "moonshot",
      groupLabel: "Moonshot AI (Kimi)",
      groupHint: "Kimi Code membership · https://www.kimi.com/membership/pricing",
    },
  }),
  novita: registration("novita", { videoGenerationProviderIds: ["novita"] }),
  nvidia: registration("nvidia", {
    providerIds: ["nvidia"],
    manifestAuthChoice: {
      pluginId: "nvidia",
      choiceId: "nvidia-api-key",
      choiceLabel: "NVIDIA API key",
      groupId: "nvidia",
      groupLabel: "NVIDIA",
      groupHint: "Direct API key",
    },
  }),
  ollama: registration("ollama", {
    providerIds: ["ollama", "ollama-cloud"],
    webSearchProviderIds: ["ollama"],
  }),
  openai: registration("openai", {
    providerIds: ["openai"],
    speechProviderIds: ["openai"],
    realtimeTranscriptionProviderIds: ["openai"],
    realtimeVoiceProviderIds: ["openai"],
    mediaUnderstandingProviderIds: ["openai"],
    imageGenerationProviderIds: ["openai"],
  }),
  "opencode-go": registration("opencode-go", {
    providerIds: ["opencode-go"],
    mediaUnderstandingProviderIds: ["opencode-go"],
  }),
  opencode: registration("opencode", {
    providerIds: ["opencode"],
    mediaUnderstandingProviderIds: ["opencode"],
  }),
  openrouter: registration("openrouter", {
    providerIds: ["openrouter"],
    mediaUnderstandingProviderIds: ["openrouter"],
    imageGenerationProviderIds: ["openrouter"],
    musicGenerationProviderIds: ["openrouter"],
    videoGenerationProviderIds: ["openrouter"],
  }),
  parallel: registration("parallel", { webSearchProviderIds: ["parallel", "parallel-free"] }),
  perplexity: registration("perplexity", { webSearchProviderIds: ["perplexity"] }),
  pixverse: registration("pixverse", { videoGenerationProviderIds: ["pixverse"] }),
  qwen: registration("qwen", {
    providerIds: [
      "qwen",
      "qwencloud",
      "modelstudio",
      "dashscope",
      "qwen-token-plan",
      "bailian-token-plan",
    ],
    mediaUnderstandingProviderIds: ["qwen"],
    videoGenerationProviderIds: ["qwen"],
  }),
  runway: registration("runway", { videoGenerationProviderIds: ["runway"] }),
  senseaudio: registration("senseaudio", { mediaUnderstandingProviderIds: ["senseaudio"] }),
  tavily: registration("tavily", {
    webSearchProviderIds: ["tavily"],
    toolNames: ["tavily_search", "tavily_extract"],
  }),
  together: registration("together", {
    providerIds: ["together"],
    videoGenerationProviderIds: ["together"],
  }),
  "tts-local-cli": registration("tts-local-cli", { speechProviderIds: ["tts-local-cli", "cli"] }),
  vydra: registration("vydra", {
    providerIds: ["vydra"],
    speechProviderIds: ["vydra"],
    imageGenerationProviderIds: ["vydra"],
    videoGenerationProviderIds: ["vydra"],
    manifestAuthChoice: {
      pluginId: "vydra",
      choiceId: "vydra-api-key",
      choiceLabel: "Vydra API key",
      groupId: "vydra",
      groupLabel: "Vydra",
      groupHint: "Image, video, and speech",
    },
  }),
  xai: registration("xai", {
    providerIds: ["xai"],
    webSearchProviderIds: ["grok"],
    realtimeTranscriptionProviderIds: ["xai"],
    mediaUnderstandingProviderIds: ["xai"],
    videoGenerationProviderIds: ["xai"],
    toolNames: ["code_execution", "x_search"],
  }),
  zai: registration("zai", {
    mediaUnderstandingProviderIds: ["zai"],
    videoGenerationProviderIds: ["zai"],
  }),
} satisfies Record<string, PluginRegistrationContractParams>;
