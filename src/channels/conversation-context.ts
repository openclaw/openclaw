/**
 * Level 102: 對話脈絡檢查
 *
 * 在消息因為沒有 @mention 而即將被跳過時，檢查是否在活躍對話中。
 * 如果是，則覆蓋跳過決定，允許消息被處理。
 */

import { existsSync } from "fs";
import { resolve } from "path";

// Time Tunnel 查詢模塊的路徑（從 workspace 解析）
const TIME_TUNNEL_QUERY_PATH = resolve(
  process.env.OPENCLAW_WORKSPACE || "/app/workspace",
  "hooks/time-tunnel/query.js",
);

// 緩存導入的模塊
let timeTunnelModule: {
  getConversationState: (
    chatId: string,
    channel?: string,
  ) => {
    isActive: boolean;
    minutesSinceReply?: number;
    lastReplyTo?: string;
    lastTopic?: string;
  };
  quickJudge: (params: {
    chatId: string;
    channel?: string;
    newMessage: string;
    sender: string;
  }) => {
    shouldRespond: boolean;
    judgment: string;
    confidence: number;
    reasoning: string;
  };
  judgeConversation: (params: {
    chatId: string;
    channel?: string;
    newMessage: string;
    sender: string;
  }) => Promise<{
    shouldRespond: boolean;
    judgment: string;
    confidence: number;
    reasoning: string;
    method: string;
    latencyMs: number;
  }>;
} | null = null;

/**
 * 動態載入 Time Tunnel 模塊
 */
async function loadTimeTunnelModule() {
  if (timeTunnelModule) {
    return timeTunnelModule;
  }

  try {
    // 檢查文件是否存在
    if (!existsSync(TIME_TUNNEL_QUERY_PATH)) {
      console.log("[conversation-context] Time Tunnel module not found, skipping");
      return null;
    }

    // 動態導入
    const module = await import(TIME_TUNNEL_QUERY_PATH);
    timeTunnelModule = {
      getConversationState: module.getConversationState,
      quickJudge: module.quickJudge,
      judgeConversation: module.judgeConversation,
    };

    console.log("[conversation-context] Time Tunnel module loaded successfully");
    return timeTunnelModule;
  } catch (err) {
    console.error("[conversation-context] Failed to load Time Tunnel module:", err);
    return null;
  }
}

export type ConversationContextResult = {
  shouldRespond: boolean;
  reason: string;
  method: "conversation-context" | "disabled" | "not-active" | "error";
  confidence?: number;
  latencyMs?: number;
};

/**
 * 檢查對話脈絡，決定是否應該回應
 *
 * @param chatId - 群組/聊天 ID（支援帶前綴格式如 "telegram:-5262004625"）
 * @param message - 消息內容
 * @param senderId - 發送者 ID
 * @param senderName - 發送者名稱
 * @param channel - 頻道類型
 * @param useLLM - 是否使用 LLM 判斷（預設 false，使用快速規則）
 */
export async function checkConversationContext(
  chatId: string | number,
  message: string,
  senderId?: string | number,
  senderName?: string,
  channel: string = "telegram",
  useLLM: boolean = false,
): Promise<ConversationContextResult> {
  const startTime = Date.now();

  try {
    const module = await loadTimeTunnelModule();
    if (!module) {
      return {
        shouldRespond: false,
        reason: "Time Tunnel 模塊未載入",
        method: "disabled",
      };
    }

    // 清理 chatId（去除 channel 前綴）
    const cleanChatId = String(chatId).replace(/^[a-z]+:/, "");

    // 1. 先檢查對話狀態
    const state = module.getConversationState(cleanChatId, channel);

    if (!state.isActive) {
      return {
        shouldRespond: false,
        reason: "不在活躍對話中",
        method: "not-active",
      };
    }

    // 2. 使用規則或 LLM 判斷
    const sender = senderName || String(senderId) || "unknown";

    if (useLLM) {
      // 使用 LLM 判斷（較慢但更準確）
      const result = await module.judgeConversation({
        chatId: cleanChatId,
        channel,
        newMessage: message,
        sender,
      });

      return {
        shouldRespond: result.shouldRespond,
        reason: result.reasoning,
        method: "conversation-context",
        confidence: result.confidence,
        latencyMs: Date.now() - startTime,
      };
    } else {
      // 使用快速規則判斷
      const result = module.quickJudge({
        chatId: cleanChatId,
        channel,
        newMessage: message,
        sender,
      });

      return {
        shouldRespond: result.shouldRespond,
        reason: result.reasoning,
        method: "conversation-context",
        confidence: result.confidence,
        latencyMs: Date.now() - startTime,
      };
    }
  } catch (err) {
    console.error("[conversation-context] Error checking conversation context:", err);
    return {
      shouldRespond: false,
      reason: `檢查失敗: ${err instanceof Error ? err.message : String(err)}`,
      method: "error",
      latencyMs: Date.now() - startTime,
    };
  }
}
