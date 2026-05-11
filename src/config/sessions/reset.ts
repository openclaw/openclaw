import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { SessionConfig, SessionResetConfig } from "../types.base.js";
export {
  DEFAULT_RESET_AT_HOUR,
  DEFAULT_RESET_MODE,
  evaluateSessionFreshness,
  resolveDailyResetAtMs,
  resolveSessionResetPolicy,
  type SessionFreshness,
  type SessionResetMode,
  type SessionResetPolicy,
  type SessionResetType,
} from "./reset-policy.js";
import type { SessionResetType } from "./reset-policy.js";

export function resolveSessionResetType(params: {
  sessionKey?: string | null;
  sessionScope?: string | null;
  chatType?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType {
  void params.sessionKey;
  if (params.isThread) {
    return "thread";
  }
  if (params.isGroup) {
    return "group";
  }
  if (params.chatType === "group" || params.chatType === "channel") {
    return "group";
  }
  if (params.sessionScope === "group" || params.sessionScope === "channel") {
    return "group";
  }
  if (params.chatType === "direct" || params.sessionScope === "shared-main") {
    return "direct";
  }
  return "direct";
}

export function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean {
  if (params.messageThreadId != null) {
    return true;
  }
  if (params.threadLabel?.trim()) {
    return true;
  }
  if (params.threadStarterBody?.trim()) {
    return true;
  }
  if (params.parentSessionKey?.trim()) {
    return true;
  }
  void params.sessionKey;
  return false;
}

export function resolveChannelResetConfig(params: {
  sessionCfg?: SessionConfig;
  channel?: string | null;
}): SessionResetConfig | undefined {
  const resetByChannel = params.sessionCfg?.resetByChannel;
  if (!resetByChannel) {
    return undefined;
  }
  const normalized = normalizeMessageChannel(params.channel);
  const fallback = normalizeOptionalLowercaseString(params.channel);
  const key = normalized ?? fallback;
  if (!key) {
    return undefined;
  }
  return resetByChannel[key];
}
