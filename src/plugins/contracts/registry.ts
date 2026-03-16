import anthropicPlugin from "../../../extensions/anthropic/index.js";
import bravePlugin from "../../../extensions/brave/index.js";
import byteplusPlugin from "../../../extensions/byteplus/index.js";
import cloudflareAiGatewayPlugin from "../../../extensions/cloudflare-ai-gateway/index.js";
import copilotProxyPlugin from "../../../extensions/copilot-proxy/index.js";
import firecrawlPlugin from "../../../extensions/firecrawl/index.js";
import githubCopilotPlugin from "../../../extensions/github-copilot/index.js";
import googlePlugin from "../../../extensions/google/index.js";
import huggingFacePlugin from "../../../extensions/huggingface/index.js";
import kilocodePlugin from "../../../extensions/kilocode/index.js";
import kimiCodingPlugin from "../../../extensions/kimi-coding/index.js";
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
import { createCapturedPluginRegistration } from "../../test-utils/plugin-registration.js";
import type { OpenClawPluginApi } from "../types.js";
import type { ProviderPlugin, WebSearchProviderPlugin } from "../types.js";

type RegistrablePlugin = {
  id: string;
  register: (api: ReturnType<typeof createCapturedPluginRegistration>["api"]) => void;
};

type ProviderContractEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

type WebSearchProviderContractEntry = {
  pluginId: string;
  provider: WebSearchProviderPlugin;
  credentialValue: unknown;
};

type PluginRegistrationContractEntry = {
  pluginId: string;
  providerIds: string[];
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

function captureRegistrations(plugin: RegistrablePlugin) {
  const captured = createCapturedPluginRegistration();
  plugin.register(captured.api);
  return captured;
}

export const providerContractRegistry: ProviderContractEntry[] = bundledProviderPlugins.flatMap(
  (plugin) => {
    const captured = captureRegistrations(plugin);
    return captured.providers.map((provider) => ({
      pluginId: plugin.id,
      provider,
    }));
  },
);

export const webSearchProviderContractRegistry: WebSearchProviderContractEntry[] =
  bundledWebSearchPlugins.flatMap((plugin) => {
    const captured = captureRegistrations(plugin);
    return captured.webSearchProviders.map((provider) => ({
      pluginId: plugin.id,
      provider,
      credentialValue: plugin.credentialValue,
    }));
  });

const bundledPluginRegistrationList = [
  ...new Map(
    [...bundledProviderPlugins, ...bundledWebSearchPlugins].map((plugin) => [plugin.id, plugin]),
  ).values(),
];

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  bundledPluginRegistrationList.map((plugin) => {
    const captured = captureRegistrations(plugin);
    return {
      pluginId: plugin.id,
      providerIds: captured.providers.map((provider) => provider.id),
      webSearchProviderIds: captured.webSearchProviders.map((provider) => provider.id),
      toolNames: captured.tools.map((tool) => tool.name),
    };
  });
