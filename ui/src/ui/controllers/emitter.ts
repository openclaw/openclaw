/**
 * Event Emitter
 * 
 * 事件发射器，用于控制器发送事件
 */

import type { AppEvent, AppEventMap } from './events.ts';

type EventListener = (event: AppEvent) => void;
type TypedEventListener<T extends AppEvent> = (event: T) => void;

/**
 * 事件发射器接口
 */
export interface EventEmitter {
  emit(event: AppEvent): void;
  on(type: string, listener: EventListener): () => void;
  off(type: string, listener: EventListener): void;
  once(type: string, listener: EventListener): void;
}

/**
 * 创建事件发射器
 */
export function createEventEmitter(): EventEmitter {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    emit(event: AppEvent) {
      const typeListeners = listeners.get(event.type);
      if (typeListeners) {
        typeListeners.forEach((listener) => {
          try {
            listener(event);
          } catch (err) {
            console.error(`Error in event listener for ${event.type}:`, err);
          }
        });
      }
      // 也触发通配符监听器
      const wildcardListeners = listeners.get('*');
      if (wildcardListeners) {
        wildcardListeners.forEach((listener) => {
          try {
            listener(event);
          } catch (err) {
            console.error('Error in wildcard event listener:', err);
          }
        });
      }
    },

    on(type: string, listener: EventListener) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
      // 返回取消订阅函数
      return () => {
        this.off(type, listener);
      };
    },

    off(type: string, listener: EventListener) {
      const typeListeners = listeners.get(type);
      if (typeListeners) {
        typeListeners.delete(listener);
      }
    },

    once(type: string, listener: EventListener) {
      const onceListener: EventListener = (event) => {
        this.off(type, onceListener);
        listener(event);
      };
      this.on(type, onceListener);
    },
  };
}

/**
 * 类型安全的事件发射器
 */
export interface TypedEventEmitter {
  emit<T extends keyof AppEventMap>(type: T, payload: AppEventMap[T]['payload']): void;
  on<T extends keyof AppEventMap>(
    type: T,
    listener: TypedEventListener<AppEventMap[T]>
  ): () => void;
}

/**
 * 全局事件发射器实例
 */
let globalEmitter: EventEmitter | null = null;

export function getGlobalEmitter(): EventEmitter {
  if (!globalEmitter) {
    globalEmitter = createEventEmitter();
  }
  return globalEmitter;
}

export function setGlobalEmitter(emitter: EventEmitter): void {
  globalEmitter = emitter;
}

/**
 * 发送事件的便捷函数
 */
export function emit(event: AppEvent): void {
  getGlobalEmitter().emit(event);
}

/**
 * 监听事件的便捷函数
 */
export function on(type: string, listener: EventListener): () => void {
  return getGlobalEmitter().on(type, listener);
}