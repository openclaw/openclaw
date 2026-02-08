/**
 * AFO Kingdom Orchestra Event Bus
 *
 * 봇 간 통신을 위한 이벤트 버스
 * Redis 또는 메모리 기반으로 동작
 */

import type { BotId, OrchestraEvent, OrchestraEventType } from "./types.js";

export interface EventBusOptions {
  type: "redis" | "memory";
  redisUrl?: string;
  channel?: string;
}

type EventHandler = (event: OrchestraEvent) => void | Promise<void>;

export class OrchestraEventBus {
  private handlers: Map<OrchestraEventType | "*", Set<EventHandler>> = new Map();
  private botHandlers: Map<BotId, Set<EventHandler>> = new Map();
  private memoryQueue: OrchestraEvent[] = [];
  private options: EventBusOptions;

  constructor(options: EventBusOptions) {
    this.options = options;
  }

  /**
   * 이벤트 발행
   */
  async publish(event: OrchestraEvent): Promise<void> {
    if (this.options.type === "memory") {
      this.memoryQueue.push(event);
      await this.dispatch(event);
    } else {
      // Redis 구현 (추후 확장)
      // await this.redis.publish(this.options.channel, JSON.stringify(event));
      await this.dispatch(event);
    }
  }

  /**
   * 이벤트 구독 (타입별)
   */
  subscribe(type: OrchestraEventType | "*", handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);

    // 구독 해제 함수 반환
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  /**
   * 이벤트 구독 (봇별)
   */
  subscribeBot(botId: BotId, handler: EventHandler): () => void {
    if (!this.botHandlers.has(botId)) {
      this.botHandlers.set(botId, new Set());
    }
    this.botHandlers.get(botId)!.add(handler);

    return () => {
      this.botHandlers.get(botId)?.delete(handler);
    };
  }

  /**
   * 이벤트 디스패치
   */
  private async dispatch(event: OrchestraEvent): Promise<void> {
    // 타입별 핸들러 실행
    const typeHandlers = this.handlers.get(event.type) || new Set();
    const wildcardHandlers = this.handlers.get("*") || new Set();

    for (const handler of [...typeHandlers, ...wildcardHandlers]) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`[EventBus] Handler error:`, error);
      }
    }

    // 봇별 핸들러 실행
    if (event.to !== "all") {
      const botHandlers = this.botHandlers.get(event.to) || new Set();
      for (const handler of botHandlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`[EventBus] Bot handler error:`, error);
        }
      }
    } else {
      // 'all'인 경우 모든 봇 핸들러 실행
      for (const [, handlers] of this.botHandlers) {
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (error) {
            console.error(`[EventBus] Bot handler error:`, error);
          }
        }
      }
    }
  }

  /**
   * 이벤트 생성 헬퍼
   */
  static createEvent(
    type: OrchestraEventType,
    from: BotId,
    to: BotId | "all",
    payload: OrchestraEvent["payload"],
  ): OrchestraEvent {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      type,
      from,
      to,
      payload,
      timestamp: Date.now(),
    };
  }
}

// 싱글톤 인스턴스
let eventBusInstance: OrchestraEventBus | null = null;

export function getEventBus(options?: EventBusOptions): OrchestraEventBus {
  if (!eventBusInstance && options) {
    eventBusInstance = new OrchestraEventBus(options);
  }
  if (!eventBusInstance) {
    throw new Error("EventBus not initialized. Call with options first.");
  }
  return eventBusInstance;
}
