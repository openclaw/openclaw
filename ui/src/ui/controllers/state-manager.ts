/**
 * State Manager
 * 
 * 统一状态管理器，处理事件并更新状态
 */

import type { AppEvent } from './events.ts';
import { EventEmitter, createEventEmitter } from './emitter.ts';
import type {
  ChatState,
  ConfigState,
  AgentsState,
  UIState,
  SessionsState,
  LogsState,
  CronState,
  UsageState,
} from '../state/index.ts';

/**
 * 应用状态接口
 */
export interface AppState {
  chat: ChatState;
  config: ConfigState;
  agents: AgentsState;
  ui: UIState;
  sessions: SessionsState;
  logs: LogsState;
  cron: CronState;
  usage: UsageState;
}

/**
 * 状态变更监听器
 */
export type StateChangeListener<T extends keyof AppState> = (
  slice: T,
  state: AppState[T],
  prevState: AppState[T]
) => void;

/**
 * 状态管理器接口
 */
export interface StateManager {
  // 状态访问
  getState<K extends keyof AppState>(slice: K): AppState[K];
  setState<K extends keyof AppState>(slice: K, state: Partial<AppState[K]>): void;

  // 监听
  subscribe<K extends keyof AppState>(
    slice: K,
    listener: StateChangeListener<K>
  ): () => void;

  // 事件处理
  dispatch(event: AppEvent): void;

  // 事件发射器
  getEmitter(): EventEmitter;
}

/**
 * 创建状态管理器
 */
export function createStateManager(initialState: Partial<AppState> = {}): StateManager {
  // 内部状态存储
  const state: AppState = {
    chat: {} as ChatState,
    config: {} as ConfigState,
    agents: {} as AgentsState,
    ui: {} as UIState,
    sessions: {} as SessionsState,
    logs: {} as LogsState,
    cron: {} as CronState,
    usage: {} as UsageState,
    ...initialState,
  } as AppState;

  // 监听器
  const listeners = new Map<keyof AppState, Set<StateChangeListener<keyof AppState>>>();
  const emitter = createEventEmitter();

  // 事件处理器映射
  const eventHandlers = new Map<string, (event: AppEvent) => void>();

  return {
    getState(slice) {
      return state[slice];
    },

    setState(slice, partialState) {
      const prevState = { ...state[slice] } as AppState[typeof slice];
      state[slice] = { ...state[slice], ...partialState } as AppState[typeof slice];

      // 通知监听器
      const sliceListeners = listeners.get(slice);
      if (sliceListeners) {
        sliceListeners.forEach((listener) => {
          listener(slice, state[slice], prevState);
        });
      }
    },

    subscribe(slice, listener) {
      if (!listeners.has(slice)) {
        listeners.set(slice, new Set());
      }
      listeners.get(slice)!.add(listener as StateChangeListener<keyof AppState>);
      return () => {
        listeners.get(slice)?.delete(listener as StateChangeListener<keyof AppState>);
      };
    },

    dispatch(event) {
      // 先发射事件
      emitter.emit(event);

      // 查找并执行事件处理器
      const handler = eventHandlers.get(event.type);
      if (handler) {
        handler(event);
      }
    },

    getEmitter() {
      return emitter;
    },
  };
}

/**
 * 全局状态管理器实例
 */
let globalStateManager: StateManager | null = null;

export function getGlobalStateManager(): StateManager {
  if (!globalStateManager) {
    globalStateManager = createStateManager();
  }
  return globalStateManager;
}

export function setGlobalStateManager(manager: StateManager): void {
  globalStateManager = manager;
}

/**
 * 便捷函数：获取状态
 */
export function getState<K extends keyof AppState>(slice: K): AppState[K] {
  return getGlobalStateManager().getState(slice);
}

/**
 * 便捷函数：设置状态
 */
export function setState<K extends keyof AppState>(
  slice: K,
  state: Partial<AppState[K]>
): void {
  getGlobalStateManager().setState(slice, state);
}

/**
 * 便捷函数：分发事件
 */
export function dispatch(event: AppEvent): void {
  getGlobalStateManager().dispatch(event);
}