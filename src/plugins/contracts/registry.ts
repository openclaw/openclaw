import anthropicPlugin from "../../../extensions/anthropic/index.js";
import bravePlugin from "../../../extensions/brave/index.js";
import elevenLabsPlugin from "../../../extensions/elevenlabs/index.js";
import firecrawlPlugin from "../../../extensions/firecrawl/index.js";
import googlePlugin from "../../../extensions/google/index.js";
import microsoftPlugin from "../../../extensions/microsoft/index.js";
import minimaxPlugin from "../../../extensions/minimax/index.js";
import mistralPlugin from "../../../extensions/mistral/index.js";
import moonshotPlugin from "../../../extensions/moonshot/index.js";
import openAIPlugin from "../../../extensions/openai/index.js";
import perplexityPlugin from "../../../extensions/perplexity/index.js";
import xaiPlugin from "../../../extensions/xai/index.js";
import zaiPlugin from "../../../extensions/zai/index.js";
import { createCapturedPluginRegistration } from "../captured-registration.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import type {
  ImageGenerationProviderPlugin,
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
type ImageGenerationProviderContractEntry = CapabilityContractEntry<ImageGenerationProviderPlugin>;

type PluginRegistrationContractEntry = {
  pluginId: string;
  providerIds: string[];
  speechProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

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

const bundledImageGenerationPlugins: RegistrablePlugin[] = [googlePlugin, openAIPlugin];

const bundledPluginRegistrationList = [
  ...new Map(
    [
      ...bundledSpeechPlugins,
      ...bundledMediaUnderstandingPlugins,
      ...bundledImageGenerationPlugins,
      ...bundledWebSearchPlugins,
    ].map((plugin) => [plugin.id, plugin]),
  ).values(),
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

function buildPluginRegistrationContractRegistry(
  providerEntries: readonly ProviderContractEntry[],
): PluginRegistrationContractEntry[] {
  const entries = [
    ...new Map(
      providerEntries.map((entry) => [
        entry.pluginId,
        {
          pluginId: entry.pluginId,
          providerIds: providerEntries
            .filter((candidate) => candidate.pluginId === entry.pluginId)
            .map((candidate) => candidate.provider.id),
          speechProviderIds: [] as string[],
          mediaUnderstandingProviderIds: [] as string[],
          imageGenerationProviderIds: [] as string[],
          webSearchProviderIds: [] as string[],
          toolNames: [] as string[],
        },
      ]),
    ).values(),
  ];

  for (const plugin of bundledPluginRegistrationList) {
    const captured = captureRegistrations(plugin);
    const existing = entries.find((entry) => entry.pluginId === plugin.id);
    const next = {
      pluginId: plugin.id,
      providerIds: captured.providers.map((provider) => provider.id),
      speechProviderIds: captured.speechProviders.map((provider) => provider.id),
      mediaUnderstandingProviderIds: captured.mediaUnderstandingProviders.map(
        (provider) => provider.id,
      ),
      imageGenerationProviderIds: captured.imageGenerationProviders.map((provider) => provider.id),
      webSearchProviderIds: captured.webSearchProviders.map((provider) => provider.id),
      toolNames: captured.tools.map((tool) => tool.name),
    };

    if (!existing) {
      entries.push(next);
      continue;
    }

    existing.providerIds = next.providerIds.length > 0 ? next.providerIds : existing.providerIds;
    existing.speechProviderIds = next.speechProviderIds;
    existing.mediaUnderstandingProviderIds = next.mediaUnderstandingProviderIds;
    existing.imageGenerationProviderIds = next.imageGenerationProviderIds;
    existing.webSearchProviderIds = next.webSearchProviderIds;
    existing.toolNames = next.toolNames;
  }

  return entries;
}

export const providerContractRegistry: ProviderContractEntry[] = [];

export let providerContractLoadError: Error | undefined;

// Keep this loader map aligned with the bundled provider ids discovered from
// manifest-registry so contract coverage keeps matching the real bundled set.
const bundledProviderContractPluginLoaders: Record<
  string,
  () => Promise<{ default: RegistrablePlugin }>
> = {
  "amazon-bedrock": () => import("../../../extensions/amazon-bedrock/index.js"),
  anthropic: () => import("../../../extensions/anthropic/index.js"),
  byteplus: () => import("../../../extensions/byteplus/index.js"),
  chutes: () => import("../../../extensions/chutes/index.js"),
  "cloudflare-ai-gateway": () => import("../../../extensions/cloudflare-ai-gateway/index.js"),
  "copilot-proxy": () => import("../../../extensions/copilot-proxy/index.js"),
  fal: () => import("../../../extensions/fal/index.js"),
  "github-copilot": () => import("../../../extensions/github-copilot/index.js"),
  google: () => import("../../../extensions/google/index.js"),
  huggingface: () => import("../../../extensions/huggingface/index.js"),
  kilocode: () => import("../../../extensions/kilocode/index.js"),
  kimi: () => import("../../../extensions/kimi-coding/index.js"),
  minimax: () => import("../../../extensions/minimax/index.js"),
  mistral: () => import("../../../extensions/mistral/index.js"),
  modelstudio: () => import("../../../extensions/modelstudio/index.js"),
  moonshot: () => import("../../../extensions/moonshot/index.js"),
  nvidia: () => import("../../../extensions/nvidia/index.js"),
  ollama: () => import("../../../extensions/ollama/index.js"),
  openai: () => import("../../../extensions/openai/index.js"),
  opencode: () => import("../../../extensions/opencode/index.js"),
  "opencode-go": () => import("../../../extensions/opencode-go/index.js"),
  openrouter: () => import("../../../extensions/openrouter/index.js"),
  qianfan: () => import("../../../extensions/qianfan/index.js"),
  "qwen-portal-auth": () => import("../../../extensions/qwen-portal-auth/index.js"),
  sglang: () => import("../../../extensions/sglang/index.js"),
  synthetic: () => import("../../../extensions/synthetic/index.js"),
  together: () => import("../../../extensions/together/index.js"),
  venice: () => import("../../../extensions/venice/index.js"),
  "vercel-ai-gateway": () => import("../../../extensions/vercel-ai-gateway/index.js"),
  vllm: () => import("../../../extensions/vllm/index.js"),
  volcengine: () => import("../../../extensions/volcengine/index.js"),
  xai: () => import("../../../extensions/xai/index.js"),
  xiaomi: () => import("../../../extensions/xiaomi/index.js"),
  zai: () => import("../../../extensions/zai/index.js"),
};

async function loadBundledProviderContractPlugins(): Promise<RegistrablePlugin[]> {
  const bundledProviderPluginIds = loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled" && plugin.providers.length > 0)
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));

  const modules = await Promise.all(
    bundledProviderPluginIds.map((pluginId) => {
      const load = bundledProviderContractPluginLoaders[pluginId];
      if (!load) {
        throw new Error(`missing bundled provider contract loader for ${pluginId}`);
      }
      return load();
    }),
  );

  return modules.map((mod, index) => {
    const plugin = mod.default as RegistrablePlugin | undefined;
    if (!plugin) {
      throw new Error(
        `bundled provider contract plugin missing default export for ${bundledProviderPluginIds[index]}`,
      );
    }
    return plugin;
  });
}

let loadedBundledProviderRegistry: ProviderContractEntry[] = [];

try {
  loadedBundledProviderRegistry = buildCapabilityContractRegistry({
    plugins: await loadBundledProviderContractPlugins(),
    select: (captured) => captured.providers,
  });
  providerContractLoadError = undefined;
} catch (error) {
  providerContractLoadError = error instanceof Error ? error : new Error(String(error));
}

providerContractRegistry.splice(
  0,
  providerContractRegistry.length,
  ...loadedBundledProviderRegistry,
);

export const uniqueProviderContractProviders: ProviderPlugin[] = [
  ...new Map(providerContractRegistry.map((entry) => [entry.provider.id, entry.provider])).values(),
];

export const providerContractPluginIds = [
  ...new Set(providerContractRegistry.map((entry) => entry.pluginId)),
].toSorted((left, right) => left.localeCompare(right));

export const providerContractCompatPluginIds = providerContractPluginIds.map((pluginId) =>
  pluginId === "kimi-coding" ? "kimi" : pluginId,
);

export function requireProviderContractProvider(providerId: string): ProviderPlugin {
  const provider = uniqueProviderContractProviders.find((entry) => entry.id === providerId);
  if (!provider) {
    if (providerContractLoadError) {
      throw new Error(
        `provider contract entry missing for ${providerId}; bundled provider registry failed to load: ${providerContractLoadError.message}`,
      );
    }
    throw new Error(`provider contract entry missing for ${providerId}`);
  }
  return provider;
}

export function resolveProviderContractPluginIdsForProvider(
  providerId: string,
): string[] | undefined {
  const pluginIds = [
    ...new Set(
      providerContractRegistry
        .filter((entry) => entry.provider.id === providerId)
        .map((entry) => entry.pluginId),
    ),
  ];
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderContractProvidersForPluginIds(
  pluginIds: readonly string[],
): ProviderPlugin[] {
  const allowed = new Set(pluginIds);
  return [
    ...new Map(
      providerContractRegistry
        .filter((entry) => allowed.has(entry.pluginId))
        .map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

export const webSearchProviderContractRegistry: WebSearchProviderContractEntry[] = [];
export const speechProviderContractRegistry: SpeechProviderContractEntry[] = [];
export const mediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  [];
export const imageGenerationProviderContractRegistry: ImageGenerationProviderContractEntry[] = [];
export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] = [];

export let capabilityContractLoadError: Error | undefined;

let loadedWebSearchProviderContractRegistry: WebSearchProviderContractEntry[] = [];
let loadedSpeechProviderContractRegistry: SpeechProviderContractEntry[] = [];
let loadedMediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  [];
let loadedImageGenerationProviderContractRegistry: ImageGenerationProviderContractEntry[] = [];
let loadedPluginRegistrationContractRegistry: PluginRegistrationContractEntry[] = [];

try {
  loadedWebSearchProviderContractRegistry = bundledWebSearchPlugins.flatMap((plugin) => {
    const captured = captureRegistrations(plugin);
    return captured.webSearchProviders.map((provider) => ({
      pluginId: plugin.id,
      provider,
      credentialValue: plugin.credentialValue,
    }));
  });

  loadedSpeechProviderContractRegistry = buildCapabilityContractRegistry({
    plugins: bundledSpeechPlugins,
    select: (captured) => captured.speechProviders,
  });

  loadedMediaUnderstandingProviderContractRegistry = buildCapabilityContractRegistry({
    plugins: bundledMediaUnderstandingPlugins,
    select: (captured) => captured.mediaUnderstandingProviders,
  });

  loadedImageGenerationProviderContractRegistry = buildCapabilityContractRegistry({
    plugins: bundledImageGenerationPlugins,
    select: (captured) => captured.imageGenerationProviders,
  });

  loadedPluginRegistrationContractRegistry = buildPluginRegistrationContractRegistry(
    loadedBundledProviderRegistry,
  );

  capabilityContractLoadError = undefined;
} catch (error) {
  capabilityContractLoadError = error instanceof Error ? error : new Error(String(error));
}

webSearchProviderContractRegistry.splice(
  0,
  webSearchProviderContractRegistry.length,
  ...loadedWebSearchProviderContractRegistry,
);

speechProviderContractRegistry.splice(
  0,
  speechProviderContractRegistry.length,
  ...loadedSpeechProviderContractRegistry,
);

mediaUnderstandingProviderContractRegistry.splice(
  0,
  mediaUnderstandingProviderContractRegistry.length,
  ...loadedMediaUnderstandingProviderContractRegistry,
);

imageGenerationProviderContractRegistry.splice(
  0,
  imageGenerationProviderContractRegistry.length,
  ...loadedImageGenerationProviderContractRegistry,
);

pluginRegistrationContractRegistry.splice(
  0,
  pluginRegistrationContractRegistry.length,
  ...loadedPluginRegistrationContractRegistry,
);
