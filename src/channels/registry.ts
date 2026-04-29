// 从插件运行时状态获取渠道注册表
import { getActivePluginChannelRegistryFromState } from "../plugins/runtime-channel-state.js";
// 字符串规范化工具函数
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
// 渠道 ID、聊天渠道别名、顺序等相关导出
import {
  CHANNEL_IDS,
  CHAT_CHANNEL_ALIASES,
  CHAT_CHANNEL_ORDER,
  listChatChannelAliases,
  normalizeChatChannelId,
  type ChatChannelId,
} from "./ids.js";
// 渠道 ID 类型
import type { ChannelId } from "./plugins/channel-id.types.js";
// 渠道元数据类型
import type { ChannelMeta } from "./plugins/types.core.js";
// 导出聊天渠道元数据和渠道列表
export { getChatChannelMeta, listChatChannels } from "./chat-meta.js";
// 导出渠道 ID 和排序后的渠道顺序
export { CHANNEL_IDS, CHAT_CHANNEL_ORDER } from "./ids.js";
// 导出聊天渠道 ID 类型
export type { ChatChannelId } from "./ids.js";

// 已注册渠道插件条目类型
type RegisteredChannelPluginEntry = {
  plugin: {
    // 插件 ID
    id?: string | null;
    // 插件元数据（别名和 markdown 支持能力）
    meta?: Pick<ChannelMeta, "aliases" | "markdownCapable"> | null;
  };
};

// 列出所有已注册的渠道插件条目
function listRegisteredChannelPluginEntries(): RegisteredChannelPluginEntry[] {
  // 获取当前活跃的渠道注册表
  const channelRegistry = getActivePluginChannelRegistryFromState();
  // 如果注册表存在且有渠道，返回渠道列表
  if (channelRegistry && channelRegistry.channels && channelRegistry.channels.length > 0) {
    return channelRegistry.channels;
  }
  return [];
}

// 查找指定规范化的已注册渠道插件条目
function findRegisteredChannelPluginEntry(
  normalizedKey: string,
): RegisteredChannelPluginEntry | undefined {
  return listRegisteredChannelPluginEntries().find((entry) => {
    // 规范化插件 ID
    const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
    // 如果 ID 匹配，返回 true
    if (id && id === normalizedKey) {
      return true;
    }
    // 检查别名是否匹配
    return (entry.plugin.meta?.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === normalizedKey,
    );
  });
}

// 通过 ID 查找已注册渠道插件条目
function findRegisteredChannelPluginEntryById(
  id: string,
): RegisteredChannelPluginEntry | undefined {
  const normalizedId = normalizeOptionalLowercaseString(id);
  if (!normalizedId) {
    return undefined;
  }
  return listRegisteredChannelPluginEntries().find(
    (entry) => normalizeOptionalLowercaseString(entry.plugin.id) === normalizedId,
  );
}

// 导出聊天渠道别名相关函数
export { CHAT_CHANNEL_ALIASES, listChatChannelAliases, normalizeChatChannelId };

// 规范化渠道 ID：用于共享代码的首选辅助函数
// 注意：不要直接从 src/channels/plugins/* 导入（会主动加载渠道实现）
export function normalizeChannelId(raw?: string | null): ChatChannelId | null {
  return normalizeChatChannelId(raw);
}

// 规范化任何渠道 ID（已注册的内置或外部渠道插件）
// 保持轻量：不导入渠道插件（可能加载监控器、Web 登录等）
// 必须先初始化插件注册表
export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return null;
  }
  return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}

// 列出所有已注册渠道插件的 ID
export function listRegisteredChannelPluginIds(): ChannelId[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => {
    const id = normalizeOptionalString(entry.plugin.id);
    return id ? [id as ChannelId] : [];
  });
}

// 列出所有已注册渠道插件的别名
export function listRegisteredChannelPluginAliases(): string[] {
  return listRegisteredChannelPluginEntries().flatMap((entry) => entry.plugin.meta?.aliases ?? []);
}

// 获取已注册渠道插件的元数据
export function getRegisteredChannelPluginMeta(
  id: string,
): Pick<ChannelMeta, "aliases" | "markdownCapable"> | null {
  return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}

// 格式化渠道初始行
export function formatChannelPrimerLine(meta: ChannelMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

// 格式化渠道选择行
export function formatChannelSelectionLine(
  meta: ChannelMeta,
  docsLink: (path: string, label?: string) => string,
): string {
  // 获取文档前缀，默认 "Docs:"
  const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
  // 获取文档标签
  const docsLabel = meta.docsLabel ?? meta.id;
  // 根据配置决定文档链接格式
  const docs = meta.selectionDocsOmitLabel
    ? docsLink(meta.docsPath)
    : docsLink(meta.docsPath, docsLabel);
  // 额外信息
  const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
  return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
