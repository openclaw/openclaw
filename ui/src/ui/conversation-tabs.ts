/**
 * Conversation tabs state: one tab = one chat context (sessionKey).
 * Tab history: closed tabs; "Keep last" N windows.
 */

import { generateUUID } from "./uuid.ts";

export const TAB_COLORS = ["purple", "green", "amber", "rose", "sky"] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export type ConversationTab = {
  id: string;
  label: string;
  color: TabColor;
  sessionKey: string;
};

export type TabHistoryEntry = {
  id: string;
  label: string;
  color: TabColor;
  sessionKey: string;
  closedAt: number;
};

export type HistoryLimit = 10 | 20 | 30 | 40;

export type ConversationTabsState = {
  conversationTabs: ConversationTab[];
  activeConversationId: string | null;
  tabHistory: TabHistoryEntry[];
  historyLimit: HistoryLimit;
};

const STORAGE_KEY = "openclaw.control.conversationTabs.v1";

const DEFAULT_LIMIT: HistoryLimit = 20;

function parseHistoryLimit(value: unknown): HistoryLimit {
  if (value === 10 || value === 20 || value === 30 || value === 40) {
    return value;
  }
  return DEFAULT_LIMIT;
}

function parseTabColor(value: unknown): TabColor {
  if (typeof value === "string" && TAB_COLORS.includes(value as TabColor)) {
    return value as TabColor;
  }
  return "purple";
}

function parseConversationTab(raw: unknown): ConversationTab | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : null;
  const label = typeof o.label === "string" ? o.label.trim() || "New chat" : "New chat";
  const sessionKey =
    typeof o.sessionKey === "string" && o.sessionKey.trim() ? o.sessionKey.trim() : null;
  if (!id || !sessionKey) {
    return null;
  }
  return {
    id,
    label,
    color: parseTabColor(o.color),
    sessionKey,
  };
}

function parseTabHistoryEntry(raw: unknown): TabHistoryEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : null;
  const label = typeof o.label === "string" ? o.label.trim() || "Chat" : "Chat";
  const sessionKey =
    typeof o.sessionKey === "string" && o.sessionKey.trim() ? o.sessionKey.trim() : null;
  const closedAt = typeof o.closedAt === "number" && o.closedAt > 0 ? o.closedAt : Date.now();
  if (!id || !sessionKey) {
    return null;
  }
  return {
    id,
    label,
    color: parseTabColor(o.color),
    sessionKey,
    closedAt,
  };
}

export function loadConversationTabsState(defaultSessionKey: string): ConversationTabsState {
  const defaultTab: ConversationTab = {
    id: generateUUID(),
    label: "New chat",
    color: "purple",
    sessionKey: defaultSessionKey,
  };
  const defaults: ConversationTabsState = {
    conversationTabs: [defaultTab],
    activeConversationId: defaultTab.id,
    tabHistory: [],
    historyLimit: DEFAULT_LIMIT,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tabs = Array.isArray(parsed.conversationTabs)
      ? (parsed.conversationTabs.map(parseConversationTab).filter(Boolean) as ConversationTab[])
      : defaults.conversationTabs;
    const tabHistory = Array.isArray(parsed.tabHistory)
      ? (parsed.tabHistory.map(parseTabHistoryEntry).filter(Boolean) as TabHistoryEntry[])
      : defaults.tabHistory;
    const historyLimit = parseHistoryLimit(parsed.historyLimit);
    const activeId =
      typeof parsed.activeConversationId === "string" && parsed.activeConversationId.trim()
        ? parsed.activeConversationId.trim()
        : null;
    if (tabs.length === 0) {
      return {
        ...defaults,
        conversationTabs: [defaultTab],
        activeConversationId: defaultTab.id,
        tabHistory,
        historyLimit,
      };
    }
    const activeExists = activeId && tabs.some((t) => t.id === activeId);
    return {
      conversationTabs: tabs,
      activeConversationId: activeExists ? activeId : tabs[0].id,
      tabHistory: tabHistory.slice(0, historyLimit),
      historyLimit,
    };
  } catch {
    return defaults;
  }
}

export function saveConversationTabsState(state: ConversationTabsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function trimHistoryToLimit(
  history: TabHistoryEntry[],
  limit: HistoryLimit,
): TabHistoryEntry[] {
  if (history.length <= limit) {
    return history;
  }
  return [...history].toSorted((a, b) => b.closedAt - a.closedAt).slice(0, limit);
}
