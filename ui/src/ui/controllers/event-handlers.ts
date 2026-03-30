/**
 * Event Handlers
 * 
 * 事件处理器注册，将事件映射到状态更新
 */

import { on } from './emitter.ts';
import { setState, getGlobalStateManager } from './state-manager.ts';
import {
  ChatEvents,
  SessionsEvents,
  ConfigEvents,
  AgentsEvents,
  UIEvents,
  ConnectionEvents,
  type AppEvent,
} from './events.ts';

/**
 * 注册所有事件处理器
 */
export function registerEventHandlers() {
  const sm = getGlobalStateManager();

  // ─────────────────────────────────────────────────────────────
  // Chat Events
  // ─────────────────────────────────────────────────────────────

  on(ChatEvents.HISTORY_LOAD_START, () => {
    setState('chat', { chatLoading: true });
  });

  on(ChatEvents.HISTORY_LOAD_SUCCESS, (event: AppEvent) => {
    const payload = event.payload as { messages: unknown[]; thinkingLevel?: string };
    setState('chat', {
      chatLoading: false,
      chatMessages: payload.messages,
      chatThinkingLevel: payload.thinkingLevel ?? null,
    });
  });

  on(ChatEvents.STREAM_DELTA, (event: AppEvent) => {
    const payload = event.payload as { text: string; runId: string };
    setState('chat', {
      chatStream: (sm.getState('chat').chatStream ?? '') + payload.text,
      chatRunId: payload.runId,
    });
  });

  on(ChatEvents.STREAM_END, () => {
    setState('chat', {
      chatStream: null,
      chatStreamStartedAt: null,
    });
  });

  on(ChatEvents.INPUT_CHANGE, (event: AppEvent) => {
    const payload = event.payload as { message: string };
    setState('chat', { chatMessage: payload.message });
  });

  on(ChatEvents.ATTACHMENT_ADD, (event: AppEvent) => {
    const payload = event.payload as { attachment: unknown };
    const current = sm.getState('chat').chatAttachments;
    setState('chat', {
      chatAttachments: [...current, payload.attachment as any],
    });
  });

  on(ChatEvents.ATTACHMENT_REMOVE, (event: AppEvent) => {
    const payload = event.payload as { id: string };
    const current = sm.getState('chat').chatAttachments;
    setState('chat', {
      chatAttachments: current.filter((a: any) => a.id !== payload.id),
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Sessions Events
  // ─────────────────────────────────────────────────────────────

  on(SessionsEvents.LOAD_START, () => {
    setState('sessions', { sessionsLoading: true });
  });

  on(SessionsEvents.LOAD_SUCCESS, (event: AppEvent) => {
    const payload = event.payload as { result: any };
    setState('sessions', {
      sessionsLoading: false,
      sessionsResult: payload.result,
      sessionsError: null,
    });
  });

  on(SessionsEvents.LOAD_ERROR, (event: AppEvent) => {
    const payload = event.payload as { error: string };
    setState('sessions', {
      sessionsLoading: false,
      sessionsError: payload.error,
    });
  });

  on(SessionsEvents.FILTER_CHANGE, (event: AppEvent) => {
    const payload = event.payload as {
      filter: {
        activeMinutes?: number;
        limit?: number;
        includeGlobal?: boolean;
        includeUnknown?: boolean;
      };
    };
    const updates: any = {};
    if (payload.filter.activeMinutes !== undefined) {
      updates.sessionsFilterActive = String(payload.filter.activeMinutes);
    }
    if (payload.filter.limit !== undefined) {
      updates.sessionsFilterLimit = String(payload.filter.limit);
    }
    if (payload.filter.includeGlobal !== undefined) {
      updates.sessionsIncludeGlobal = payload.filter.includeGlobal;
    }
    if (payload.filter.includeUnknown !== undefined) {
      updates.sessionsIncludeUnknown = payload.filter.includeUnknown;
    }
    setState('sessions', updates);
  });

  on(SessionsEvents.SELECT, (event: AppEvent) => {
    const payload = event.payload as { sessionKey: string };
    setState('chat', { sessionKey: payload.sessionKey });
  });

  // ─────────────────────────────────────────────────────────────
  // UI Events
  // ─────────────────────────────────────────────────────────────

  on(UIEvents.TAB_CHANGE, (event: AppEvent) => {
    const payload = event.payload as { tab: string };
    setState('ui', { tab: payload.tab as any });
  });

  on(UIEvents.NAV_TOGGLE, () => {
    const current = sm.getState('ui').navDrawerOpen;
    setState('ui', { navDrawerOpen: !current });
  });

  on(UIEvents.THEME_CHANGE, (event: AppEvent) => {
    const payload = event.payload as { theme: string; mode?: string };
    setState('ui', {
      theme: payload.theme as any,
      ...(payload.mode ? { themeMode: payload.mode as any } : {}),
    });
  });

  on(UIEvents.SIDEBAR_TOGGLE, () => {
    const current = sm.getState('ui').sidebarOpen;
    setState('ui', { sidebarOpen: !current });
  });

  on(UIEvents.PALETTE_TOGGLE, () => {
    const current = sm.getState('ui').paletteOpen;
    setState('ui', { paletteOpen: !current, paletteQuery: '' });
  });

  // ─────────────────────────────────────────────────────────────
  // Connection Events
  // ─────────────────────────────────────────────────────────────

  on(ConnectionEvents.CONNECTING, () => {
    setState('ui', { connected: false });
  });

  on(ConnectionEvents.CONNECTED, () => {
    setState('ui', { connected: true, lastError: null, lastErrorCode: null });
  });

  on(ConnectionEvents.DISCONNECTED, () => {
    setState('ui', { connected: false });
  });

  on(ConnectionEvents.ERROR, (event: AppEvent) => {
    const payload = event.payload as { error: string; code?: string };
    setState('ui', {
      connected: false,
      lastError: payload.error,
      lastErrorCode: payload.code ?? null,
    });
  });
}

/**
 * 在应用启动时注册事件处理器
 */
export function initializeEventSystem() {
  registerEventHandlers();
  console.log('[EventSystem] Event handlers registered');
}