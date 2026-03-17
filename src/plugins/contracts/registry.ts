import anthropicPlugin from "../../../extensions/anthropic/index.js";
import bravePlugin from "../../../extensions/brave/index.js";
import byteplusPlugin from "../../../extensions/byteplus/index.js";
import cloudflareAiGatewayPlugin from "../../../extensions/cloudflare-ai-gateway/index.js";
import copilotProxyPlugin from "../../../extensions/copilot-proxy/index.js";
import elevenLabsPlugin from "../../../extensions/elevenlabs/index.js";
import firecrawlPlugin from "../../../extensions/firecrawl/index.js";
import githubCopilotPlugin from "../../../extensions/github-copilot/index.js";
import googlePlugin from "../../../extensions/google/index.js";
import huggingFacePlugin from "../../../extensions/huggingface/index.js";
import kilocodePlugin from "../../../extensions/kilocode/index.js";
import kimiCodingPlugin from "../../../extensions/kimi-coding/index.js";
import microsoftPlugin from "../../../extensions/microsoft/index.js";
import minimaxPlugin from "../../../extensions/minimax/index.js";
import mistralPlugin from "../../../extensions/mistral/index.js";
import modelStudioPlugin from "../../../extensions/modelstudio/index.js";
import moonshotPlugin from "../../../extensions/moonshot/index.js";
import nvidiaPlugin from "../../../extensions/nvidia/index.js";
import ollamaPlugin from "../../../extensions/ollama/index.js";
import openAIPlugin from "../../../extensions/openai/index.js";
import opencodeGoPlugin from "../../../extensions/opencode-go/index.js";
import opencodePlugin from "../../../extensions/opencode/index.js";
import openRouterPlugin from "../../../extensions/openrouter/index.js";
import perplexityPlugin from "../../../extensions/perplexity/index.js";
import qianfanPlugin from "../../../extensions/qianfan/index.js";
import qwenPortalPlugin from "../../../extensions/qwen-portal-auth/index.js";
import sglangPlugin from "../../../extensions/sglang/index.js";
import syntheticPlugin from "../../../extensions/synthetic/index.js";
import togetherPlugin from "../../../extensions/together/index.js";
import venicePlugin from "../../../extensions/venice/index.js";
import vercelAiGatewayPlugin from "../../../extensions/vercel-ai-gateway/index.js";
import vllmPlugin from "../../../extensions/vllm/index.js";
import volcenginePlugin from "../../../extensions/volcengine/index.js";
import xaiPlugin from "../../../extensions/xai/index.js";
import xiaomiPlugin from "../../../extensions/xiaomi/index.js";
import zaiPlugin from "../../../extensions/zai/index.js";
import { createCapturedPluginRegistration } from "../captured-registration.js";
import type {
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
  WebSearchProviderPlugin,
} from "../types.js";

type RegistrablePlugin = {
  id: string;
  register: (api: ReturnType<typeof createCapturedPluginRegistration>["api"]) => void;
};

type CapabilityContractEntry<T> = {
  pluginId: string;
  provider: T;
};

type ProviderContractEntry = CapabilityContractEntry<ProviderPlugin>;

type WebSearchProviderContractEntry = CapabilityContractEntry<WebSearchProviderPlugin> & {
  credentialValue: unknown;
};

type SpeechProviderContractEntry = CapabilityContractEntry<SpeechProviderPlugin>;
type MediaUnderstandingProviderContractEntry =
  CapabilityContractEntry<MediaUnderstandingProviderPlugin>;

type PluginRegistrationContractEntry = {
  pluginId: string;
  providerIds: string[];
  speechProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

const bundledProviderPlugins: RegistrablePlugin[] = [
  anthropicPlugin,
  byteplusPlugin,
  cloudflareAiGatewayPlugin,
  copilotProxyPlugin,
  githubCopilotPlugin,
  googlePlugin,
  huggingFacePlugin,
  kilocodePlugin,
  kimiCodingPlugin,
  minimaxPlugin,
  mistralPlugin,
  modelStudioPlugin,
  moonshotPlugin,
  nvidiaPlugin,
  ollamaPlugin,
  opencodeGoPlugin,
  opencodePlugin,
  openAIPlugin,
  openRouterPlugin,
  qianfanPlugin,
  qwenPortalPlugin,
  sglangPlugin,
  syntheticPlugin,
  togetherPlugin,
  venicePlugin,
  vercelAiGatewayPlugin,
  vllmPlugin,
  volcenginePlugin,
  xaiPlugin,
  xiaomiPlugin,
  zaiPlugin,
];

const bundledWebSearchPlugins: Array<RegistrablePlugin & { credentialValue: unknown }> = [
  { ...bravePlugin, credentialValue: "BSA-test" },
  { ...firecrawlPlugin, credentialValue: "fc-test" },
  { ...googlePlugin, credentialValue: "AIza-test" },
  { ...moonshotPlugin, credentialValue: "sk-test" },
  { ...perplexityPlugin, credentialValue: "pplx-test" },
  { ...xaiPlugin, credentialValue: "xai-test" },
];

const bundledSpeechPlugins: RegistrablePlugin[] = [elevenLabsPlugin, microsoftPlugin, openAIPlugin];

const bundledMediaUnderstandingPlugins: RegistrablePlugin[] = [
  anthropicPlugin,
  googlePlugin,
  minimaxPlugin,
  mistralPlugin,
  moonshotPlugin,
  openAIPlugin,
  zaiPlugin,
];

function captureRegistrations(plugin: RegistrablePlugin) {
  const captured = createCapturedPluginRegistration();
  plugin.register(captured.api);
  return captured;
}

function buildCapabilityContractRegistry<T>(params: {
  plugins: RegistrablePlugin[];
  select: (captured: ReturnType<typeof createCapturedPluginRegistration>) => T[];
}): CapabilityContractEntry<T>[] {
  return params.plugins.flatMap((plugin) => {
    const captured = captureRegistrations(plugin);
    return params.select(captured).map((provider) => ({
      pluginId: plugin.id,
      provider,
    }));
  });
}

export const providerContractRegistry: ProviderContractEntry[] = buildCapabilityContractRegistry({
  plugins: bundledProviderPlugins,
  select: (captured) => captured.providers,
});

export const webSearchProviderContractRegistry: WebSearchProviderContractEntry[] =
  bundledWebSearchPlugins.flatMap((plugin) => {
    const captured = captureRegistrations(plugin);
    return captured.webSearchProviders.map((provider) => ({
      pluginId: plugin.id,
      provider,
      credentialValue: plugin.credentialValue,
    }));
  });

export const speechProviderContractRegistry: SpeechProviderContractEntry[] =
  buildCapabilityContractRegistry({
    plugins: bundledSpeechPlugins,
    select: (captured) => captured.speechProviders,
  });

export const mediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  buildCapabilityContractRegistry({
    plugins: bundledMediaUnderstandingPlugins,
    select: (captured) => captured.mediaUnderstandingProviders,
  });

const bundledPluginRegistrationList = [
  ...new Map(
    [
      ...bundledProviderPlugins,
      ...bundledSpeechPlugins,
      ...bundledMediaUnderstandingPlugins,
      ...bundledWebSearchPlugins,
    ].map((plugin) => [plugin.id, plugin]),
  ).values(),
];

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  bundledPluginRegistrationList.map((plugin) => {
    const captured = captureRegistrations(plugin);
    return {
      pluginId: plugin.id,
      providerIds: captured.providers.map((provider) => provider.id),
      speechProviderIds: captured.speechProviders.map((provider) => provider.id),
      mediaUnderstandingProviderIds: captured.mediaUnderstandingProviders.map(
        (provider) => provider.id,
      ),
      webSearchProviderIds: captured.webSearchProviders.map((provider) => provider.id),
      toolNames: captured.tools.map((tool) => tool.name),
    };
  });
