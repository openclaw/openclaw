import { resolveToolDisplay } from "../agents/tool-display.js";

export interface ToolActivityAdapter {
  sendMessage(text: string): Promise<string>;
  editMessage(messageId: string, text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

export type ToolActivityLevel = "off" | "minimal" | "detailed";

interface ToolEntry {
  name: string;
  displayName: string;
  emoji: string;
  meta?: string;
  completed: boolean;
}

export interface ToolActivityStatusController {
  onToolStart(toolName: string, meta?: string): void;
  onToolEnd(toolName: string): void;
  cleanup(): Promise<void>;
}

const MIN_EDIT_GAP_MS = 300;
const FINAL_DELETE_DELAY_MS = 2000;

function normalizeLevel(level: ToolActivityLevel | undefined): ToolActivityLevel {
  if (level === "detailed" || level === "minimal" || level === "off") {
    return level;
  }
  return "off";
}

function normalizeToolName(value: string | undefined): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : "tool";
}

function formatStatusMeta(meta: string): string {
  const trimmed = meta.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("`")) {
    return trimmed;
  }
  return `\`${trimmed}\``;
}

function formatStatusSegment(entry: ToolEntry, level: ToolActivityLevel): string {
  const icon = entry.completed ? "✅" : "🔧";
  if (level !== "detailed" || !entry.meta?.trim()) {
    return `${icon} ${entry.displayName}`;
  }
  const formattedMeta = formatStatusMeta(entry.meta);
  if (!formattedMeta) {
    return `${icon} ${entry.displayName}`;
  }
  return `${icon} ${entry.displayName}: ${formattedMeta}`;
}

function formatStatusLine(tools: ToolEntry[], level: ToolActivityLevel): string {
  const normalizedLevel = normalizeLevel(level);
  if (normalizedLevel === "off" || tools.length === 0) {
    return "";
  }
  return tools.map((entry) => formatStatusSegment(entry, normalizedLevel)).join(" · ");
}

export function createToolActivityStatusController(params: {
  adapter: ToolActivityAdapter;
  level: ToolActivityLevel;
  onError?: (err: unknown) => void;
}): ToolActivityStatusController {
  const level = normalizeLevel(params.level);

  if (level === "off") {
    return {
      onToolStart: () => {},
      onToolEnd: () => {},
      cleanup: async () => {},
    };
  }

  let tools: ToolEntry[] = [];
  let messageId: string | null = null;
  let lastRenderedLine = "";
  let pendingLine = "";
  let lastMutationAt = 0;
  let debounceTimer: NodeJS.Timeout | null = null;
  let finalDeleteTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let chainPromise = Promise.resolve();

  const reportError = (err: unknown) => {
    try {
      params.onError?.(err);
    } catch {
      // Never allow error hooks to break message flow.
    }
  };

  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    chainPromise = chainPromise.then(fn, fn);
    return chainPromise.catch((err) => {
      reportError(err);
    });
  };

  const clearDebounceTimer = () => {
    if (!debounceTimer) {
      return;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const clearFinalDeleteTimer = () => {
    if (!finalDeleteTimer) {
      return;
    }
    clearTimeout(finalDeleteTimer);
    finalDeleteTimer = null;
  };

  const renderPending = (immediate = false) => {
    if (disposed) {
      return;
    }
    pendingLine = formatStatusLine(tools, level);
    if (!pendingLine) {
      return;
    }

    const flush = () => {
      debounceTimer = null;
      const line = pendingLine;
      if (!line || line === lastRenderedLine || disposed) {
        return;
      }

      void enqueue(async () => {
        if (disposed) {
          return;
        }
        try {
          if (!messageId) {
            messageId = await params.adapter.sendMessage(line);
          } else {
            await params.adapter.editMessage(messageId, line);
          }
          lastRenderedLine = line;
          lastMutationAt = Date.now();
        } catch (err) {
          reportError(err);
        }
      });
    };

    if (immediate) {
      clearDebounceTimer();
      flush();
      return;
    }

    const elapsed = Date.now() - lastMutationAt;
    const waitMs = Math.max(0, MIN_EDIT_GAP_MS - elapsed);
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(flush, waitMs);
  };

  const scheduleFinalDelete = () => {
    clearFinalDeleteTimer();
    finalDeleteTimer = setTimeout(() => {
      void cleanupInternal();
    }, FINAL_DELETE_DELAY_MS);
  };

  const cleanupInternal = async (): Promise<void> => {
    clearDebounceTimer();
    clearFinalDeleteTimer();
    disposed = true;
    tools = [];
    pendingLine = "";

    await enqueue(async () => {
      if (!messageId) {
        return;
      }
      const currentMessageId = messageId;
      messageId = null;
      lastRenderedLine = "";
      try {
        await params.adapter.deleteMessage(currentMessageId);
      } catch (err) {
        reportError(err);
      }
    });
  };

  const upsertStart = (toolName: string, meta?: string) => {
    const display = resolveToolDisplay({ name: toolName, meta });
    const normalizedName = normalizeToolName(display.name || toolName);
    const normalizedMeta =
      typeof display.detail === "string"
        ? display.detail.trim() || undefined
        : typeof meta === "string"
          ? meta.trim() || undefined
          : undefined;
    const existing = tools.find((entry) => !entry.completed && entry.name === normalizedName);
    if (existing) {
      existing.meta = normalizedMeta || existing.meta;
      existing.displayName = existing.displayName || normalizedName;
      existing.emoji = existing.emoji || display.emoji;
      return;
    }
    tools.push({
      name: normalizedName,
      displayName: normalizedName,
      emoji: display.emoji,
      meta: normalizedMeta,
      completed: false,
    });
  };

  const markEnd = (toolName: string) => {
    const normalizedName = normalizeToolName(toolName);
    const matching = tools.find((entry) => !entry.completed && entry.name === normalizedName);
    if (matching) {
      matching.completed = true;
      return;
    }
    const fallback = tools.find((entry) => !entry.completed);
    if (fallback) {
      fallback.completed = true;
    }
  };

  return {
    onToolStart: (toolName, meta) => {
      if (disposed) {
        return;
      }
      clearFinalDeleteTimer();
      upsertStart(toolName, meta);
      renderPending(!messageId);
    },
    onToolEnd: (toolName) => {
      if (disposed) {
        return;
      }
      markEnd(toolName);
      renderPending(true);
      if (tools.length > 0 && tools.every((entry) => entry.completed)) {
        scheduleFinalDelete();
      }
    },
    cleanup: cleanupInternal,
  };
}
