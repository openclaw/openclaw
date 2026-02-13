/**
 * Level 50: In-Flight Request Tracker
 *
 * 追蹤正在處理中的消息，確保 graceful shutdown 時等待完成。
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("in-flight");

interface InFlightRequest {
  id: string;
  chatId: string;
  channel: string;
  startedAt: number;
  messagePreview: string;
}

// 存儲所有 in-flight 請求
const inFlightRequests = new Map<string, InFlightRequest>();

// 等待 shutdown 的 resolvers
let shutdownWaiters: Array<() => void> = [];
let isShuttingDown = false;

/**
 * 生成唯一請求 ID
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 記錄開始處理消息
 */
export function trackMessageStart(params: {
  chatId: string;
  channel: string;
  messagePreview?: string;
}): string {
  const id = generateRequestId();
  const request: InFlightRequest = {
    id,
    chatId: params.chatId,
    channel: params.channel,
    startedAt: Date.now(),
    messagePreview: params.messagePreview?.slice(0, 50) || "(no preview)",
  };

  inFlightRequests.set(id, request);
  log.info(`[+] in-flight: ${inFlightRequests.size} (${params.channel}:${params.chatId})`);

  return id;
}

/**
 * 記錄消息處理完成
 */
export function trackMessageEnd(requestId: string): void {
  const request = inFlightRequests.get(requestId);
  if (request) {
    const duration = Date.now() - request.startedAt;
    inFlightRequests.delete(requestId);
    log.info(`[-] in-flight: ${inFlightRequests.size} (completed in ${duration}ms)`);

    // 如果正在 shutdown 且沒有 pending 請求了，通知 waiters
    if (isShuttingDown && inFlightRequests.size === 0) {
      for (const resolve of shutdownWaiters) {
        resolve();
      }
      shutdownWaiters = [];
    }
  }
}

/**
 * 獲取當前 in-flight 請求數量
 */
export function getInFlightCount(): number {
  return inFlightRequests.size;
}

/**
 * 獲取所有 in-flight 請求詳情
 */
export function getInFlightRequests(): InFlightRequest[] {
  return Array.from(inFlightRequests.values());
}

/**
 * 等待所有 in-flight 請求完成
 * @param timeoutMs 超時時間（毫秒），預設 30 秒
 */
export async function waitForInFlightCompletion(timeoutMs = 30000): Promise<{
  completed: boolean;
  remaining: number;
  timedOut: boolean;
}> {
  isShuttingDown = true;

  const count = inFlightRequests.size;
  if (count === 0) {
    log.info("no in-flight requests; ready to shutdown");
    return { completed: true, remaining: 0, timedOut: false };
  }

  log.info(`waiting for ${count} in-flight request(s) to complete...`);

  // 列出正在處理的請求
  for (const req of inFlightRequests.values()) {
    const elapsed = Date.now() - req.startedAt;
    log.info(`  - ${req.channel}:${req.chatId} (${elapsed}ms) "${req.messagePreview}"`);
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      const remaining = inFlightRequests.size;
      if (remaining > 0) {
        log.warn(`shutdown timeout: ${remaining} request(s) still pending, proceeding anyway`);
        for (const req of inFlightRequests.values()) {
          log.warn(`  - abandoned: ${req.channel}:${req.chatId} "${req.messagePreview}"`);
        }
      }
      resolve({ completed: remaining === 0, remaining, timedOut: true });
    }, timeoutMs);

    // 如果已經沒有 pending 了
    if (inFlightRequests.size === 0) {
      clearTimeout(timeoutId);
      resolve({ completed: true, remaining: 0, timedOut: false });
      return;
    }

    // 等待所有請求完成
    shutdownWaiters.push(() => {
      clearTimeout(timeoutId);
      resolve({ completed: true, remaining: 0, timedOut: false });
    });
  });
}

/**
 * 重置狀態（用於測試）
 */
export function resetTracker(): void {
  inFlightRequests.clear();
  shutdownWaiters = [];
  isShuttingDown = false;
}
