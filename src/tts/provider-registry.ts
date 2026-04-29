import type { OpenClawConfig } from "../config/types.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "../plugins/capability-provider-runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
export { normalizeSpeechProviderId } from "./provider-registry-core.js";
import {
  createSpeechProviderRegistry,
  type SpeechProviderRegistryResolver,
} from "./provider-registry-core.js";

/**
 * 解析语音提供商插件条目
 * @param cfg - 可选的OpenClaw配置
 * @returns 语音提供商插件数组
 */
function resolveSpeechProviderPluginEntries(cfg?: OpenClawConfig): SpeechProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "speechProviders",
    cfg,
  });
}

/**
 * 默认语音提供商注册解析器
 */
const defaultSpeechProviderRegistryResolver: SpeechProviderRegistryResolver = {
  getProvider: (providerId, cfg) =>
    resolvePluginCapabilityProvider({
      key: "speechProviders",
      providerId,
      cfg,
    }),
  listProviders: resolveSpeechProviderPluginEntries,
};

/**
 * 默认语音提供商注册表
 */
const defaultSpeechProviderRegistry = createSpeechProviderRegistry(
  defaultSpeechProviderRegistryResolver,
);

/**
 * 列出所有语音提供商
 */
export const listSpeechProviders = defaultSpeechProviderRegistry.listSpeechProviders;

/**
 * 获取语音提供商
 */
export const getSpeechProvider = defaultSpeechProviderRegistry.getSpeechProvider;

/**
 * 规范化语音提供商ID
 */
export const canonicalizeSpeechProviderId =
  defaultSpeechProviderRegistry.canonicalizeSpeechProviderId;
