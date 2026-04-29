import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import {
  buildCapabilityProviderMaps,
  normalizeCapabilityProviderId,
} from "../plugins/provider-registry-shared.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceProviderId } from "./provider-types.js";

/**
 * 规范化实时语音提供商ID
 * @param providerId - 提供商ID
 * @returns 规范化后的ID或undefined
 */
export function normalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
): RealtimeVoiceProviderId | undefined {
  return normalizeCapabilityProviderId(providerId);
}

/**
 * 解析实时语音提供商条目
 * @param cfg - 可选的OpenClaw配置
 * @returns 提供商插件数组
 */
function resolveRealtimeVoiceProviderEntries(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[] {
  return resolvePluginCapabilityProviders({
    key: "realtimeVoiceProviders",
    cfg,
  });
}

/**
 * 构建提供商映射
 * @param cfg - 可选的OpenClaw配置
 * @returns 规范映射和别名映射
 */
function buildProviderMaps(cfg?: OpenClawConfig): {
  canonical: Map<string, RealtimeVoiceProviderPlugin>;
  aliases: Map<string, RealtimeVoiceProviderPlugin>;
} {
  return buildCapabilityProviderMaps(resolveRealtimeVoiceProviderEntries(cfg));
}

/**
 * 列出所有实时语音提供商
 * @param cfg - 可选的OpenClaw配置
 * @returns 提供商数组
 */
export function listRealtimeVoiceProviders(cfg?: OpenClawConfig): RealtimeVoiceProviderPlugin[] {
  return [...buildProviderMaps(cfg).canonical.values()];
}

/**
 * 获取实时语音提供商
 * @param providerId - 提供商ID
 * @param cfg - 可选的OpenClaw配置
 * @returns 提供商插件或undefined
 */
export function getRealtimeVoiceProvider(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderPlugin | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return buildProviderMaps(cfg).aliases.get(normalized);
}

/**
 * 规范化实时语音提供商ID到规范形式
 * @param providerId - 提供商ID
 * @param cfg - 可选的OpenClaw配置
 * @returns 规范化ID或undefined
 */
export function canonicalizeRealtimeVoiceProviderId(
  providerId: string | undefined,
  cfg?: OpenClawConfig,
): RealtimeVoiceProviderId | undefined {
  const normalized = normalizeRealtimeVoiceProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return getRealtimeVoiceProvider(normalized, cfg)?.id ?? normalized;
}
