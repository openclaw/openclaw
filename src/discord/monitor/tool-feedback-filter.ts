import { formatToolFeedbackDiscord, resolveToolDisplay } from "../../agents/tool-display.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("discord/tool-feedback");

const DEFAULT_BUFFER_MS = 4000;
const DEFAULT_MAX_WAIT_MS = 10000;
const DEFAULT_COOLDOWN_MS = 15000;
const MAX_FEEDBACK_LINES = 5;

type BufferedTool = {
  toolName: string;
  input?: Record<string, unknown>;
  timestamp: number;
};

type GroupedTool = {
  toolName: string;
  count: number;
  /** Representative input from first occurrence. */
  firstInput?: Record<string, unknown>;
  /** Whether all entries share the same base command/path. */
  isHomogeneous: boolean;
};

export type UnifiedToolFeedbackConfig = {
  /** Buffer window before flushing (ms). Default 3000. */
  bufferMs?: number;
  /** Max time before flushing regardless (ms). Default 8000. */
  maxWaitMs?: number;
  /** Min interval between emitted messages (ms). Default 10000. */
  cooldownMs?: number;
};

/**
 * Extract the base command from a shell command string.
 * For "export FOO=bar && gog calendar events '...'" returns
 * "gog calendar events" (strips env vars and quoted args).
 */
function extractBaseCommand(cmd: string): string {
  // Strip leading env var exports: export FOO=bar &&
  let cleaned = cmd.replace(/^(?:export\s+\S+=\S+\s*&&\s*)+/g, "").trim();
  // Strip leading echo commands chained with &&
  cleaned = cleaned.replace(/^echo\s+"[^"]*"\s*&&\s*/g, "").trim();
  // Strip stderr/stdout redirections
  cleaned = cleaned.replace(/\s*[12]?>\s*\/dev\/null/g, "").trim();
  // Strip trailing pipe chains (| head, | tail, | python3, etc.)
  cleaned = cleaned.replace(/\s*\|.*$/, "").trim();
  // Take only the command name + first two args (skip long
  // quoted args like calendar IDs)
  const parts = cleaned.split(/\s+/);
  const significant: string[] = [];
  for (const part of parts) {
    // Stop at quoted args or long args (likely IDs/paths)
    if (part.startsWith("'") || part.startsWith('"') || part.startsWith("--")) {
      break;
    }
    // Stop at args that look like email addresses or long IDs
    if (part.includes("@") || part.length > 40) {
      break;
    }
    significant.push(part);
    if (significant.length >= 3) {
      break;
    }
  }
  return significant.join(" ") || cleaned.split(/\s+/).slice(0, 2).join(" ");
}

/**
 * Extract the detail value used for homogeneity comparison.
 * For Bash: extracts the base command. For Read/Write/Edit:
 * extracts the file path. For others: returns undefined.
 */
function extractComparisonKey(
  toolName: string,
  input?: Record<string, unknown>,
): string | undefined {
  if (!input) {
    return undefined;
  }
  const key = toolName.toLowerCase();
  if (key === "bash" || key === "exec") {
    const cmd = input.command;
    if (typeof cmd === "string") {
      return extractBaseCommand(cmd);
    }
  }
  if (key === "read" || key === "write" || key === "edit") {
    const path = input.file_path ?? input.path;
    if (typeof path === "string") {
      return path;
    }
  }
  return undefined;
}

function groupTools(tools: BufferedTool[]): GroupedTool[] {
  // Group by tool name
  const groups = new Map<
    string,
    { count: number; firstInput?: Record<string, unknown>; compKeys: Set<string> }
  >();
  for (const tool of tools) {
    const group = groups.get(tool.toolName) ?? {
      count: 0,
      firstInput: tool.input,
      compKeys: new Set(),
    };
    group.count += 1;
    const compKey = extractComparisonKey(tool.toolName, tool.input);
    if (compKey) {
      group.compKeys.add(compKey);
    }
    groups.set(tool.toolName, group);
  }

  return [...groups.entries()].map(([name, g]) => ({
    toolName: name,
    count: g.count,
    firstInput: g.firstInput,
    // Homogeneous if all entries share the same base command/path
    isHomogeneous: g.compKeys.size <= 1,
  }));
}

function formatGroupedFeedback(groups: GroupedTool[]): string {
  const lines: string[] = [];

  for (const group of groups) {
    const display = resolveToolDisplay({
      name: group.toolName,
      args: group.firstInput,
    });

    if (group.count > 1 && group.isHomogeneous) {
      // Homogeneous group: show base command/detail with count
      const key = group.toolName.toLowerCase();
      if (key === "bash" || key === "exec") {
        const cmd = group.firstInput?.command;
        if (typeof cmd === "string") {
          const base = extractBaseCommand(cmd);
          lines.push(`${display.emoji} Running \`${base}\` (x${group.count})`);
          continue;
        }
      }
      // Other homogeneous groups: use standard format + count
      const formatted = formatToolFeedbackDiscord(display);
      lines.push(`${formatted} (x${group.count})`);
    } else if (group.count > 1) {
      // Heterogeneous group: just show tool name + count
      const formatted = formatToolFeedbackDiscord(display);
      lines.push(`${formatted} (x${group.count})`);
    } else {
      // Single tool: full format
      lines.push(formatToolFeedbackDiscord(display));
    }
  }

  // Cap output to avoid overly verbose feedback.
  if (lines.length > MAX_FEEDBACK_LINES) {
    const shown = lines.slice(0, MAX_FEEDBACK_LINES);
    const remaining = lines.length - MAX_FEEDBACK_LINES;
    shown.push(`…and ${remaining} more`);
    return shown.join("\n");
  }
  return lines.join("\n");
}

/**
 * Create a unified tool feedback system for Discord that buffers
 * tool calls, groups similar commands, rate-limits output, and
 * formats using code blocks for a clean user experience.
 *
 * Replaces the old LLM-based tool-feedback-filter with
 * deterministic formatting and grouping.
 */
export function createUnifiedToolFeedback(params: {
  onUpdate: (text: string) => void;
  config?: UnifiedToolFeedbackConfig;
}): {
  push: (tool: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) => void;
  dispose: () => void;
  /** Suppress updates for the given duration (e.g. after smart-ack). */
  suppress: (durationMs: number) => void;
} {
  const bufferMs = params.config?.bufferMs ?? DEFAULT_BUFFER_MS;
  const maxWaitMs = params.config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const cooldownMs = params.config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

  const buffer: BufferedTool[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let flushing = false;
  let lastEmitTime = 0;
  let suppressedUntil = 0;

  function flush() {
    if (buffer.length === 0 || flushing || disposed) {
      return;
    }
    if (Date.now() < suppressedUntil) {
      return;
    }

    // Enforce cooldown: if too soon since last emit, reschedule
    const timeSinceEmit = Date.now() - lastEmitTime;
    if (lastEmitTime > 0 && timeSinceEmit < cooldownMs) {
      clearTimers();
      const delay = cooldownMs - timeSinceEmit;
      debounceTimer = setTimeout(() => flush(), delay);
      return;
    }

    flushing = true;

    // Take all buffered tools
    const batch = buffer.splice(0, buffer.length);
    clearTimers();

    try {
      const groups = groupTools(batch);
      const feedback = formatGroupedFeedback(groups);
      logVerbose(`tool-feedback: ${feedback}`);

      if (feedback && !disposed) {
        lastEmitTime = Date.now();
        params.onUpdate(feedback);
      }
    } catch (err) {
      log.warn(`tool-feedback: flush failed: ${String(err)}`);
    } finally {
      flushing = false;
    }
  }

  function clearTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
  }

  function push(tool: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) {
    if (disposed) {
      return;
    }
    buffer.push({
      toolName: tool.toolName,
      input: tool.input,
      timestamp: Date.now(),
    });

    // Reset debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => flush(), bufferMs);

    // Start max-wait timer on first tool in batch
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => flush(), maxWaitMs);
    }
  }

  function suppress(durationMs: number) {
    suppressedUntil = Date.now() + durationMs;
  }

  function dispose() {
    disposed = true;
    clearTimers();
  }

  return { push, dispose, suppress };
}

// Keep old exports for backward compatibility with other channels
export {
  type UnifiedToolFeedbackConfig as ToolFeedbackFilterConfig,
  createUnifiedToolFeedback as createToolFeedbackFilter,
};
