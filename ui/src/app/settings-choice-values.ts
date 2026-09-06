const CHAT_SEND_SHORTCUTS = ["enter", "modifier-enter"] as const;
export type ChatSendShortcut = (typeof CHAT_SEND_SHORTCUTS)[number];

function normalizeChoice<T extends string>(
  values: readonly T[],
  fallback: T,
): (value: unknown) => T {
  return (value) => (values.includes(value as T) ? (value as T) : fallback);
}

export const normalizeChatSendShortcut = normalizeChoice(CHAT_SEND_SHORTCUTS, "enter");

const CHAT_FOLLOW_UP_MODES = ["queue", "steer"] as const;
export type ChatFollowUpMode = (typeof CHAT_FOLLOW_UP_MODES)[number];

export const normalizeChatFollowUpMode = normalizeChoice(CHAT_FOLLOW_UP_MODES, "steer");

export function normalizeChatFollowUpModeOverride(value: unknown): ChatFollowUpMode | undefined {
  return CHAT_FOLLOW_UP_MODES.includes(value as ChatFollowUpMode)
    ? (value as ChatFollowUpMode)
    : undefined;
}

const CATALOG_OPEN_TARGETS = ["viewer", "terminal"] as const;
export type CatalogOpenTarget = (typeof CATALOG_OPEN_TARGETS)[number];

export const normalizeCatalogOpenTarget = normalizeChoice(CATALOG_OPEN_TARGETS, "viewer");

const CHAT_WORKSPACE_DOCKS = ["right", "bottom"] as const;
export type ChatWorkspaceDock = (typeof CHAT_WORKSPACE_DOCKS)[number];

export const normalizeChatWorkspaceDock = normalizeChoice(CHAT_WORKSPACE_DOCKS, "right");
