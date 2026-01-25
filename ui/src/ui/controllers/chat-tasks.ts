/**
 * Task derivation logic for the Chat Task Sidebar.
 * Converts tool stream entries into tasks and activity logs.
 */

import type { ToolStreamEntry } from "../app-tool-stream";
import type { ChatTask, ChatActivityLog, TaskStatus } from "../types/task-types";

/** Format a tool name for human-readable display */
export function formatToolName(name: string): string {
  // Handle common tool naming patterns
  const parts = name.split(/[_.-]/);
  const formatted = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");

  // Common tool name mappings
  const mappings: Record<string, string> = {
    "Read": "Read File",
    "Write": "Write File",
    "Edit": "Edit File",
    "Bash": "Run Command",
    "Grep": "Search Code",
    "Glob": "Find Files",
    "Task": "Run Task",
    "Web Fetch": "Fetch URL",
    "Web Search": "Search Web",
  };

  return mappings[formatted] || formatted;
}

/** Summarize tool arguments for display */
export function summarizeToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";

  const record = args as Record<string, unknown>;

  // Extract meaningful info based on tool type
  switch (name.toLowerCase()) {
    case "read":
      return typeof record.file_path === "string"
        ? truncatePath(record.file_path)
        : "";
    case "write":
      return typeof record.file_path === "string"
        ? truncatePath(record.file_path)
        : "";
    case "edit":
      return typeof record.file_path === "string"
        ? truncatePath(record.file_path)
        : "";
    case "bash":
      return typeof record.command === "string"
        ? truncateText(record.command, 60)
        : "";
    case "grep":
      return typeof record.pattern === "string"
        ? `"${truncateText(record.pattern, 40)}"`
        : "";
    case "glob":
      return typeof record.pattern === "string"
        ? truncateText(record.pattern, 50)
        : "";
    case "task":
      return typeof record.description === "string"
        ? truncateText(record.description, 50)
        : "";
    case "webfetch":
    case "mcp__fetch__fetch":
      return typeof record.url === "string"
        ? truncateUrl(record.url)
        : "";
    case "websearch":
      return typeof record.query === "string"
        ? `"${truncateText(record.query, 40)}"`
        : "";
    default:
      // Try to find a meaningful field
      for (const key of ["path", "file", "query", "name", "description", "url"]) {
        if (typeof record[key] === "string") {
          return truncateText(record[key] as string, 50);
        }
      }
      return "";
  }
}

/** Truncate a file path for display */
function truncatePath(path: string): string {
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  const filename = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return `.../${parent}/${filename}`;
}

/** Truncate text with ellipsis */
function truncateText(text: string, maxLen: number): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 3) + "...";
}

/** Truncate a URL for display */
function truncateUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.length > 40) {
      return parsed.host + path.slice(0, 37) + "...";
    }
    return parsed.host + path;
  } catch {
    return truncateText(url, 50);
  }
}

/** Determine task status from a tool stream entry */
function deriveTaskStatus(entry: ToolStreamEntry): TaskStatus {
  if (entry.output !== undefined) {
    // Check if output indicates an error
    const outputLower = entry.output.toLowerCase();
    if (
      outputLower.includes("error:") ||
      outputLower.includes("failed:") ||
      outputLower.includes("exception:")
    ) {
      return "error";
    }
    return "completed";
  }
  return "in-progress";
}

/** Generate a unique ID for activity log entries */
let activityCounter = 0;
function nextActivityId(): string {
  return `activity-${++activityCounter}`;
}

/** Derive tasks and activity log from tool stream entries */
export function deriveTasksFromToolStream(
  entries: ToolStreamEntry[],
): { tasks: ChatTask[]; activityLog: ChatActivityLog[] } {
  const tasks: ChatTask[] = [];
  const activityLog: ChatActivityLog[] = [];

  for (const entry of entries) {
    const status = deriveTaskStatus(entry);
    const summary = summarizeToolArgs(entry.name, entry.args);

    // Create task
    const task: ChatTask = {
      id: entry.toolCallId,
      name: formatToolName(entry.name),
      status,
      startedAt: entry.startedAt,
      completedAt: status === "completed" || status === "error" ? entry.updatedAt : null,
      error: status === "error" ? extractErrorMessage(entry.output) : null,
      children: [],
      toolCallId: entry.toolCallId,
      args: entry.args,
      output: entry.output,
    };
    tasks.push(task);

    // Create activity log entries
    activityLog.push({
      id: nextActivityId(),
      type: "tool-start",
      timestamp: entry.startedAt,
      title: `${formatToolName(entry.name)}${summary ? `: ${summary}` : ""}`,
      toolCallId: entry.toolCallId,
    });

    if (entry.output !== undefined) {
      activityLog.push({
        id: nextActivityId(),
        type: status === "error" ? "tool-error" : "tool-result",
        timestamp: entry.updatedAt,
        title: status === "error"
          ? `Error in ${formatToolName(entry.name)}`
          : `${formatToolName(entry.name)} completed`,
        details: truncateText(entry.output, 200),
        toolCallId: entry.toolCallId,
      });
    }
  }

  // Sort activity log by timestamp
  activityLog.sort((a, b) => a.timestamp - b.timestamp);

  return { tasks, activityLog };
}

/** Extract error message from tool output */
function extractErrorMessage(output: string | undefined): string | null {
  if (!output) return null;
  const lines = output.split("\n");
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("error:") || lower.includes("failed:")) {
      return truncateText(line, 100);
    }
  }
  return truncateText(output, 100);
}

/** Count tasks by status */
export function countTasksByStatus(tasks: ChatTask[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    "not-started": 0,
    "in-progress": 0,
    "completed": 0,
    "error": 0,
    "user-feedback": 0,
  };

  for (const task of tasks) {
    counts[task.status]++;
  }

  return counts;
}
