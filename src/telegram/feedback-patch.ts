/**
 * 需要添加到 bot-handlers.ts 的代碼
 *
 * 插入位置：
 * 1. 頂部 import 區域
 * 2. callback_query handler 內部（約第 440 行後）
 */

// ========== 第 1 處：頂部添加 import ==========
// 在現有 import 後面添加：
/*
import {
  isAutoMemoryFeedback,
  handleFeedbackCallback,
} from "./feedback-integration.js";
*/

// ========== 第 2 處：callback_query handler 內部 ==========
// 在現有處理邏輯後面（約第 485 行 return; 後）添加：

/*
      // Auto-Memory 反饋按鈕處理
      if (isAutoMemoryFeedback(data)) {
        await handleFeedbackCallback(bot, data, callbackMessage, runtime);
        return;
      }
*/

// ========== 完整 context ==========
// 現有代碼（約第 442-485 行）：
//       const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
//       if (paginationMatch) {
//         ... 處理 commands 分頁 ...
//         return;
//       }
//
//       const modelCallback = parseModelCallbackData(data);
//       if (modelCallback) {
//         ... 處理模型選擇 ...
//         return;
//       }
//
// ===== 在這裡插入 Auto-Memory 處理 =====
//
//       // Auto-Memory 反饋按鈕處理
//       if (isAutoMemoryFeedback(data)) {
//         await handleFeedbackCallback(bot, data, callbackMessage, runtime);
//         return;
//       }

// ========== 第 3 處：修改 delivery ==========
// 文件：src/telegram/bot/delivery.ts
//
// 在頂部 import 添加：
/*
import { attachFeedbackButtons } from "../feedback-integration.js";
*/

// 在 deliverReplies 函數中，發送消息前處理 payload：
// （約第 88 行附近，for (const reply of replies) 循環內）
/*
      // 添加 Auto-Memory 反饋按鈕
      const replyWithFeedback = attachFeedbackButtons(reply, {
        conversationLength: replies.length,
        sessionKey: thread?.sessionKey || "unknown",
      });
*/
// 然後使用 replyWithFeedback 代替 reply
