/**
 * Event Types
 * 
 * 定义所有控制器事件类型
 */

// ─────────────────────────────────────────────────────────────
// Base Event
// ─────────────────────────────────────────────────────────────

export interface AppEvent {
  type: string;
  payload?: unknown;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────
// Chat Events
// ─────────────────────────────────────────────────────────────

export const ChatEvents = {
  HISTORY_LOAD_START: 'chat:history:load:start',
  HISTORY_LOAD_SUCCESS: 'chat:history:load:success',
  HISTORY_LOAD_ERROR: 'chat:history:load:error',
  SEND_START: 'chat:send:start',
  SEND_SUCCESS: 'chat:send:success',
  SEND_ERROR: 'chat:send:error',
  STREAM_DELTA: 'chat:stream:delta',
  STREAM_END: 'chat:stream:end',
  MESSAGE_ADD: 'chat:message:add',
  MESSAGE_CLEAR: 'chat:message:clear',
  INPUT_CHANGE: 'chat:input:change',
  ATTACHMENT_ADD: 'chat:attachment:add',
  ATTACHMENT_REMOVE: 'chat:attachment:remove',
} as const;

export interface ChatHistoryLoadStartEvent extends AppEvent {
  type: typeof ChatEvents.HISTORY_LOAD_START;
}

export interface ChatHistoryLoadSuccessEvent extends AppEvent {
  type: typeof ChatEvents.HISTORY_LOAD_SUCCESS;
  payload: {
    messages: unknown[];
    thinkingLevel?: string;
  };
}

export interface ChatStreamDeltaEvent extends AppEvent {
  type: typeof ChatEvents.STREAM_DELTA;
  payload: {
    text: string;
    runId: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Sessions Events
// ─────────────────────────────────────────────────────────────

export const SessionsEvents = {
  LOAD_START: 'sessions:load:start',
  LOAD_SUCCESS: 'sessions:load:success',
  LOAD_ERROR: 'sessions:load:error',
  FILTER_CHANGE: 'sessions:filter:change',
  SELECT: 'sessions:select',
  DELETE: 'sessions:delete',
} as const;

export interface SessionsLoadStartEvent extends AppEvent {
  type: typeof SessionsEvents.LOAD_START;
}

export interface SessionsLoadSuccessEvent extends AppEvent {
  type: typeof SessionsEvents.LOAD_SUCCESS;
  payload: {
    result: import('../types.ts').SessionsListResult;
  };
}

// ─────────────────────────────────────────────────────────────
// Config Events
// ─────────────────────────────────────────────────────────────

export const ConfigEvents = {
  LOAD_START: 'config:load:start',
  LOAD_SUCCESS: 'config:load:success',
  LOAD_ERROR: 'config:load:error',
  SAVE_START: 'config:save:start',
  SAVE_SUCCESS: 'config:save:success',
  SAVE_ERROR: 'config:save:error',
  FORM_CHANGE: 'config:form:change',
  RAW_CHANGE: 'config:raw:change',
} as const;

// ─────────────────────────────────────────────────────────────
// Agents Events
// ─────────────────────────────────────────────────────────────

export const AgentsEvents = {
  LOAD_START: 'agents:load:start',
  LOAD_SUCCESS: 'agents:load:success',
  LOAD_ERROR: 'agents:load:error',
  SELECT: 'agents:select',
  FILES_LOAD: 'agents:files:load',
  TOOLS_LOAD: 'agents:tools:load',
} as const;

// ─────────────────────────────────────────────────────────────
// UI Events
// ─────────────────────────────────────────────────────────────

export const UIEvents = {
  TAB_CHANGE: 'ui:tab:change',
  NAV_TOGGLE: 'ui:nav:toggle',
  THEME_CHANGE: 'ui:theme:change',
  SIDEBAR_TOGGLE: 'ui:sidebar:toggle',
  PALETTE_TOGGLE: 'ui:palette:toggle',
} as const;

export interface UITabChangeEvent extends AppEvent {
  type: typeof UIEvents.TAB_CHANGE;
  payload: {
    tab: string;
  };
}

// ─────────────────────────────────────────────────────────────
// Connection Events
// ─────────────────────────────────────────────────────────────

export const ConnectionEvents = {
  CONNECTING: 'connection:connecting',
  CONNECTED: 'connection:connected',
  DISCONNECTED: 'connection:disconnected',
  ERROR: 'connection:error',
} as const;

export interface ConnectionConnectedEvent extends AppEvent {
  type: typeof ConnectionEvents.CONNECTED;
  payload: {
    hello: import('../gateway.ts').GatewayHelloOk;
  };
}

// ─────────────────────────────────────────────────────────────
// Event Map (for type-safe event handling)
// ─────────────────────────────────────────────────────────────

export type AppEventMap = {
  [ChatEvents.HISTORY_LOAD_START]: ChatHistoryLoadStartEvent;
  [ChatEvents.HISTORY_LOAD_SUCCESS]: ChatHistoryLoadSuccessEvent;
  [ChatEvents.STREAM_DELTA]: ChatStreamDeltaEvent;
  [SessionsEvents.LOAD_START]: SessionsLoadStartEvent;
  [SessionsEvents.LOAD_SUCCESS]: SessionsLoadSuccessEvent;
  [UIEvents.TAB_CHANGE]: UITabChangeEvent;
  [ConnectionEvents.CONNECTED]: ConnectionConnectedEvent;
  // ... 其他事件类型
};

// ─────────────────────────────────────────────────────────────
// Event Creator Helpers
// ─────────────────────────────────────────────────────────────

export function createEvent<T extends string>(type: T, payload?: unknown): AppEvent {
  return {
    type,
    payload,
    timestamp: Date.now(),
  };
}