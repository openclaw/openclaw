/**
 * Sessions Controller (Refactored)
 * 
 * 事件驱动版本的 Sessions 控制器
 * 不再直接操作状态，而是发送事件
 */

import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";
import { emit, createEvent } from "./emitter.ts";
import { SessionsEvents } from "./events.ts";

/**
 * Sessions 控制器选项
 */
export interface SessionsControllerOptions {
  client: GatewayBrowserClient | null;
  connected: boolean;
}

/**
 * 创建 Sessions 控制器
 */
export function createSessionsController(options: SessionsControllerOptions) {
  const { client, connected } = options;

  return {
    /**
     * 订阅会话更新
     */
    async subscribe() {
      if (!client || !connected) {
        return;
      }
      try {
        await client.request("sessions.subscribe", {});
      } catch (err) {
        emit(
          createEvent(SessionsEvents.LOAD_ERROR, {
            error: String(err),
          })
        );
      }
    },

    /**
     * 加载会话列表
     */
    async load(params?: {
      activeMinutes?: number;
      limit?: number;
      includeGlobal?: boolean;
      includeUnknown?: boolean;
    }) {
      if (!client || !connected) {
        return;
      }

      // 发送加载开始事件
      emit(createEvent(SessionsEvents.LOAD_START));

      try {
        const includeGlobal = params?.includeGlobal ?? true;
        const includeUnknown = params?.includeUnknown ?? false;
        const activeMinutes = params?.activeMinutes ?? 0;
        const limit = params?.limit ?? 120;

        const requestParams: Record<string, unknown> = {
          includeGlobal,
          includeUnknown,
        };

        if (activeMinutes > 0) {
          requestParams.activeMinutes = activeMinutes;
        }
        if (limit > 0) {
          requestParams.limit = limit;
        }

        const result = await client.request<SessionsListResult>(
          "sessions.list",
          requestParams
        );

        // 发送成功事件
        emit(
          createEvent(SessionsEvents.LOAD_SUCCESS, {
            result,
          })
        );

        return result;
      } catch (err) {
        let errorMessage = String(err);

        if (isMissingOperatorReadScopeError(err)) {
          errorMessage = formatMissingOperatorReadScopeMessage(
            "sessions.list",
            err as { data?: { missing?: string[] } }
          );
        }

        // 发送错误事件
        emit(
          createEvent(SessionsEvents.LOAD_ERROR, {
            error: errorMessage,
          })
        );

        throw err;
      }
    },

    /**
     * 删除会话
     */
    async delete(sessionKey: string) {
      if (!client || !connected) {
        return;
      }

      try {
        await client.request("sessions.delete", {
          key: sessionKey,
        });

        // 发送删除事件
        emit(
          createEvent(SessionsEvents.DELETE, {
            sessionKey,
          })
        );

        // 刷新列表
        await this.load();
      } catch (err) {
        emit(
          createEvent(SessionsEvents.LOAD_ERROR, {
            error: String(err),
          })
        );
        throw err;
      }
    },

    /**
     * 更新过滤器
     */
    updateFilter(filter: {
      activeMinutes?: number;
      limit?: number;
      includeGlobal?: boolean;
      includeUnknown?: boolean;
    }) {
      emit(
        createEvent(SessionsEvents.FILTER_CHANGE, {
          filter,
        })
      );
    },

    /**
     * 选择会话
     */
    select(sessionKey: string) {
      emit(
        createEvent(SessionsEvents.SELECT, {
          sessionKey,
        })
      );
    },
  };
}

// 导出类型以保持向后兼容
export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

// 向后兼容的函数包装
export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  }
) {
  const controller = createSessionsController({
    client: state.client,
    connected: state.connected,
  });

  return controller.load({
    activeMinutes: overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0),
    limit: overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0),
    includeGlobal: overrides?.includeGlobal ?? state.sessionsIncludeGlobal,
    includeUnknown: overrides?.includeUnknown ?? state.sessionsIncludeUnknown,
  });
}

export async function subscribeSessions(state: SessionsState) {
  const controller = createSessionsController({
    client: state.client,
    connected: state.connected,
  });
  return controller.subscribe();
}

export async function deleteSessionsAndRefresh(
  state: SessionsState,
  keys: string[]
) {
  const controller = createSessionsController({
    client: state.client,
    connected: state.connected,
  });

  for (const key of keys) {
    await controller.delete(key);
  }
}