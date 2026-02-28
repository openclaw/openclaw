/**
 * Channel-agnostic tool progress controller.
 * Shows real-time tool execution status via edit-in-place status messages.
 *
 * Lifecycle:
 *   1. `onToolStart(name, meta)` — sends/edits a status message (e.g. "🔧 Running exec: ls -la")
 *   2. `onToolEnd(name, meta, isError)` — updates with completion mark
 *   3. `cleanup()` — deletes the status message when the reply is delivered
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ToolProgressConfig = {
  /** Enable tool progress status messages (default: false). */
  enabled?: boolean;
  /** Minimum interval between status message edits (ms). Default: 1500. */
  throttleMs?: number;
  /** Maximum number of completed tool lines to keep visible. Default: 3. */
  maxVisibleTools?: number;
};

export type ToolProgressAdapter = {
  /** Send a new status message. Returns a message ID for subsequent edits. */
  send: (text: string) => Promise<string | number | undefined>;
  /** Edit an existing status message by ID. */
  edit: (messageId: string | number, text: string) => Promise<void>;
  /** Delete a status message by ID. */
  delete: (messageId: string | number) => Promise<void>;
};

export type ToolProgressController = {
  onToolStart: (name?: string, meta?: string) => void;
  onToolEnd: (name?: string, meta?: string, isError?: boolean) => void;
  cleanup: () => Promise<void>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_THROTTLE_MS = 1500;
const DEFAULT_MAX_VISIBLE_TOOLS = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type CompletedTool = { label: string; isError: boolean };

function formatToolLine(meta: string | undefined, name: string | undefined): string {
  if (meta) {
    return meta;
  }
  if (name) {
    return name;
  }
  return "tool";
}

function buildStatusText(params: {
  completed: CompletedTool[];
  active: string | undefined;
  maxVisible: number;
}): string {
  const { completed, active, maxVisible } = params;
  const lines: string[] = [];

  // Show last N completed tools
  const visible = completed.slice(-maxVisible);
  const hidden = completed.length - visible.length;
  if (hidden > 0) {
    lines.push(`... ${hidden} more`);
  }
  for (const tool of visible) {
    const mark = tool.isError ? "❌" : "✅";
    lines.push(`${mark} ${tool.label}`);
  }

  if (active) {
    lines.push(`⏳ ${active}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Controller
// ─────────────────────────────────────────────────────────────────────────────

export function createToolProgressController(params: {
  enabled: boolean;
  adapter: ToolProgressAdapter;
  config?: ToolProgressConfig;
  onError?: (err: unknown) => void;
}): ToolProgressController {
  const { enabled, adapter, onError } = params;
  const throttleMs = params.config?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const maxVisibleTools = params.config?.maxVisibleTools ?? DEFAULT_MAX_VISIBLE_TOOLS;

  // State
  let messageId: string | number | undefined;
  let activeTool: string | undefined;
  const completedTools: CompletedTool[] = [];
  let lastEditAt = 0;
  let lastSentText = "";
  let pendingUpdate = false;
  let flushEnqueued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let chainPromise = Promise.resolve();

  function enqueue(fn: () => Promise<void>): void {
    chainPromise = chainPromise.then(fn).catch((err) => {
      onError?.(err);
    });
  }

  function scheduleFlush(): void {
    if (timer || stopped) {
      return;
    }
    const delay = Math.max(0, throttleMs - (Date.now() - lastEditAt));
    timer = setTimeout(() => {
      timer = undefined;
      if (pendingUpdate && !stopped) {
        pendingUpdate = false;
        flushEnqueued = true;
        enqueue(flushUpdate);
      }
    }, delay);
  }

  async function flushUpdate(): Promise<void> {
    flushEnqueued = false;
    const text = buildStatusText({
      completed: completedTools,
      active: activeTool,
      maxVisible: maxVisibleTools,
    });

    if (!text) {
      return;
    }

    // Skip no-op edits to avoid "message is not modified" API errors.
    if (text === lastSentText && messageId !== undefined) {
      return;
    }

    try {
      if (messageId === undefined) {
        messageId = await adapter.send(text);
      } else {
        await adapter.edit(messageId, text);
      }
      lastSentText = text;
      lastEditAt = Date.now();
    } catch (err) {
      onError?.(err);
    }
  }

  function requestUpdate(): void {
    if (stopped) {
      return;
    }
    // If a flush is already enqueued but not yet executed, coalesce into it.
    if (flushEnqueued) {
      return;
    }
    const elapsed = Date.now() - lastEditAt;
    if (elapsed >= throttleMs) {
      pendingUpdate = false;
      flushEnqueued = true;
      enqueue(flushUpdate);
    } else {
      pendingUpdate = true;
      scheduleFlush();
    }
  }

  return {
    onToolStart(name, meta) {
      if (!enabled || stopped) {
        return;
      }
      activeTool = formatToolLine(meta, name);
      requestUpdate();
    },

    onToolEnd(name, meta, isError) {
      if (!enabled || stopped) {
        return;
      }
      const label = formatToolLine(meta, name);
      completedTools.push({ label, isError: isError === true });
      activeTool = undefined;
      requestUpdate();
    },

    async cleanup() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Wait for in-flight operations
      await chainPromise;
      if (messageId !== undefined) {
        try {
          await adapter.delete(messageId);
        } catch (err) {
          onError?.(err);
        }
        messageId = undefined;
      }
    },
  };
}
