/**
 * Telegram 反饋集成 - Auto-Memory 反饋按鈕
 *
 * 設計原則：
 * 1. 非侵入式 - 不改變核心回覆流程
 * 2. 條件觸發 - 只在長對話後顯示
 * 3. 異步處理 - 反饋不阻塞用戶
 */

import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import type { ReplyPayload } from "../auto-reply/types.js";

// 反饋按鈕配置
const FEEDBACK_BUTTONS = [
  [
    { text: "👍 有用", callback_data: "am_fb:useful" },
    { text: "👎 無用", callback_data: "am_fb:not_useful" },
  ],
  [
    { text: "📝 記錄經驗", callback_data: "am_fb:record" },
    { text: "❓ 需背景", callback_data: "am_fb:context" },
  ],
];

// 判斷是否應該添加反饋按鈕
export function shouldAttachFeedback(replyText: string, conversationLength: number): boolean {
  // 只在對話較長時顯示（避免打擾簡單對話）
  if (conversationLength < 3) {
    return false;
  }

  // 只在有實質內容時顯示
  if (!replyText || replyText.length < 50) {
    return false;
  }

  // 不在錯誤消息上顯示
  if (replyText.includes("⚠️") || replyText.includes("❌")) {
    return false;
  }

  return true;
}

// 為回覆添加反饋按鈕
export function attachFeedbackButtons(
  payload: ReplyPayload,
  context: {
    conversationLength: number;
    sessionKey: string;
    messageId?: string;
  },
): ReplyPayload {
  if (!shouldAttachFeedback(payload.text || "", context.conversationLength)) {
    return payload;
  }

  // 構建帶 metadata 的 callback_data
  const buttons = FEEDBACK_BUTTONS.map((row) =>
    row.map((btn) => ({
      ...btn,
      callback_data: `${btn.callback_data}:${context.sessionKey}:${context.messageId || "0"}`,
    })),
  );

  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: {
        ...((payload.channelData as Record<string, unknown>)?.telegram as Record<string, unknown>),
        buttons,
      },
    },
  };
}

// 檢查是否為 Auto-Memory 反饋回調
export function isAutoMemoryFeedback(callbackData: string): boolean {
  return callbackData.startsWith("am_fb:");
}

// 解析反饋回調數據
export function parseFeedbackCallback(callbackData: string): {
  type: string;
  sessionKey: string;
  messageId: string;
} | null {
  const match = callbackData.match(/^am_fb:(\w+):([^:]+):(\w+)$/);
  if (!match) {
    return null;
  }

  return {
    type: match[1],
    sessionKey: match[2],
    messageId: match[3],
  };
}

// 處理反饋回調
export async function handleFeedbackCallback(
  bot: Bot,
  callbackData: string,
  message: Message,
  runtime: { log?: (msg: string) => void },
): Promise<void> {
  const feedback = parseFeedbackCallback(callbackData);
  if (!feedback) {
    return;
  }

  // 記錄到本地文件（不阻塞，異步）
  recordFeedback(feedback, message).catch((err) => {
    runtime?.log?.(`[feedback] error: ${err}`);
  });

  // 給用戶即時反饋（編輯原消息移除按鈕）
  try {
    await bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
      reply_markup: { inline_keyboard: [] },
    });

    // 發送確認消息（3秒後刪除）
    const confirmMsg = await bot.api.sendMessage(
      message.chat.id,
      getFeedbackConfirmText(feedback.type),
      { reply_to_message_id: message.message_id },
    );

    // 延遲刪除確認
    setTimeout(() => {
      bot.api.deleteMessage(message.chat.id, confirmMsg.message_id).catch(() => {});
    }, 3000);
  } catch (err) {
    runtime?.log?.(`[feedback] UI update failed: ${err}`);
  }
}

// 記錄反饋到文件
async function recordFeedback(
  feedback: { type: string; sessionKey: string; messageId: string },
  message: Message,
): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");
  const os = await import("os");

  const logEntry = {
    timestamp: new Date().toISOString(),
    type: feedback.type,
    sessionKey: feedback.sessionKey,
    messageId: feedback.messageId,
    chatId: message.chat.id,
    fromId: message.from?.id,
  };

  const logFile = path.join(os.homedir(), ".openclaw/skills/auto-memory/feedback_telegram.jsonl");

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n");
}

// 獲取確認文字
function getFeedbackConfirmText(type: string): string {
  const map: Record<string, string> = {
    useful: "✅ 已記錄為『有用』，會優先推薦",
    not_useful: "👎 已記錄，會改進相關算法",
    record: "📝 已記錄此對話為經驗",
    context: "❓ 已記錄，下次會提供更多背景",
  };
  return map[type] || "✓ 已記錄";
}
