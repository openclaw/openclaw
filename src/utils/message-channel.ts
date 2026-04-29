// 聊天渠道元数据工具
import { getChatChannelMeta } from "../channels/chat-meta.js";
// 渠道注册表和规范化工具
import { getRegisteredChannelPluginMeta, normalizeChatChannelId } from "../channels/registry.js";
// 网关客户端模式和名称相关类型和常量
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";

// 从 message-channel-normalize.ts 导出的函数和类型
export {
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  listDeliverableMessageChannels,
  listGatewayAgentChannelAliases,
  listGatewayAgentChannelValues,
  listGatewayMessageChannels,
  normalizeMessageChannel,
  resolveGatewayMessageChannel,
  resolveMessageChannel,
  type DeliverableMessageChannel,
  type GatewayAgentChannelHint,
  type GatewayMessageChannel,
} from "./message-channel-normalize.js";

// 从 message-channel-constants.ts 导出的常量
export {
  INTERNAL_MESSAGE_CHANNEL,
  INTERNAL_NON_DELIVERY_CHANNELS,
  isInternalNonDeliveryChannel,
  type InternalMessageChannel,
  type InternalNonDeliveryChannel,
} from "./message-channel-constants.js";

// 导入内部消息通道常量
import {
  INTERNAL_MESSAGE_CHANNEL,
  type InternalMessageChannel,
} from "./message-channel-constants.js";

// 导入消息通道规范化函数和类型
import {
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "./message-channel-normalize.js";

// 导出网关客户端名称和模式常量
export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

// 网关客户端信息类似类型
type GatewayClientInfoLike = {
  mode?: string | null;  // 客户端模式
  id?: string | null;  // 客户端 ID
};

// 检查是否是网关 CLI 客户端
export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

// 检查是否是操作员 UI 客户端
export function isOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI;
}

// 检查是否是浏览器操作员 UI 客户端
export function isBrowserOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI;
}

// 检查是否是内部消息通道
export function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

// 检查是否是 Webchat 客户端
export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}

// 检查是否是支持 Markdown 的消息通道
export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  // 内部通道和 TUI 默认支持 Markdown
  if (channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return true;
  }
  // 检查内置渠道
  const builtInChannel = normalizeChatChannelId(channel);
  if (builtInChannel) {
    return getChatChannelMeta(builtInChannel).markdownCapable === true;
  }
  // 检查注册的渠道插件
  return getRegisteredChannelPluginMeta(channel)?.markdownCapable === true;
}
