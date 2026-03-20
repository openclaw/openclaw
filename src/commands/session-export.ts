import fs from "node:fs";
import path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import type {
  SessionEntry as PiSessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  resolveDefaultSessionStorePath,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import type { RuntimeEnv } from "../runtime.js";

export type SessionExportFormat = "md" | "json";

export interface SessionExportOptions {
  sessionKey: string;
  agentId?: string;
  format: SessionExportFormat;
  output?: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function extractUserText(msg: UserMessage): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  return msg.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "image") {
        return "[Image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractAssistantText(msg: AssistantMessage): { text: string; toolCalls: string[] } {
  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "toolCall") {
      const argsStr = JSON.stringify(block.arguments, null, 2);
      toolCalls.push(`${block.name}(${argsStr})`);
    }
    // Skip thinking blocks in export
  }

  return { text: textParts.join("\n"), toolCalls };
}

function extractToolResultText(msg: ToolResultMessage): string {
  return msg.content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "image") {
        return "[Image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function sessionEntriesToMarkdown(
  header: SessionHeader | null,
  entries: PiSessionEntry[],
): string {
  const lines: string[] = [];

  // Header
  const sessionId = header?.id ?? "unknown";
  const startTime = header?.timestamp ? new Date(header.timestamp).toLocaleString() : "unknown";
  lines.push(`# Session: ${sessionId}`);
  lines.push("");
  lines.push(`**Started:** ${startTime}`);

  const messageEntries = entries.filter((e): e is SessionMessageEntry => e.type === "message");
  const messageCount = messageEntries.filter(
    (e) => (e.message as UserMessage | AssistantMessage | ToolResultMessage).role !== "toolResult",
  ).length;
  lines.push(`**Messages:** ${messageCount}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const entry of entries) {
    if (entry.type !== "message") {
      if (entry.type === "compaction") {
        lines.push(`*[Session compacted]*`);
        lines.push("");
      }
      continue;
    }

    const msgEntry = entry;
    const msg = msgEntry.message as UserMessage | AssistantMessage | ToolResultMessage;
    const time = formatTime(msg.timestamp);

    if (msg.role === "user") {
      const text = extractUserText(msg);
      lines.push(`**User** (${time}):`);
      lines.push(text);
      lines.push("");
    } else if (msg.role === "assistant") {
      const { text, toolCalls } = extractAssistantText(msg);
      lines.push(`**Assistant** (${time}):`);
      if (text) {
        lines.push(text);
      }
      for (const tc of toolCalls) {
        lines.push("");
        lines.push("<details>");
        lines.push(`<summary>Tool call</summary>`);
        lines.push("");
        lines.push("```");
        lines.push(tc);
        lines.push("```");
        lines.push("");
        lines.push("</details>");
      }
      lines.push("");
    } else if (msg.role === "toolResult") {
      const text = extractToolResultText(msg);
      const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
      if (truncated) {
        lines.push("<details>");
        lines.push(
          `<summary>Tool result: ${msg.toolName}${msg.isError ? " (error)" : ""}</summary>`,
        );
        lines.push("");
        lines.push("```");
        lines.push(truncated);
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

export async function sessionExportCommand(
  options: SessionExportOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const { sessionKey, agentId, format, output } = options;

  // Resolve session file path
  const storePath = resolveDefaultSessionStorePath(agentId);
  const sessionStore = loadSessionStore(storePath);
  const entry = sessionStore[sessionKey];

  if (!entry?.sessionId) {
    runtime.error(`Session not found: ${sessionKey}`);
    runtime.exit(1);
    return;
  }

  const sessionFile = resolveSessionFilePath(
    entry.sessionId,
    entry,
    resolveSessionFilePathOptions({ agentId }),
  );

  if (!fs.existsSync(sessionFile)) {
    runtime.error(`Session file not found: ${sessionFile}`);
    runtime.exit(1);
    return;
  }

  // Load session
  const sessionManager = SessionManager.open(sessionFile);
  const entries = sessionManager.getEntries();
  const header = sessionManager.getHeader();

  let result: string;

  if (format === "json") {
    result = JSON.stringify({ header, entries }, null, 2);
  } else {
    result = sessionEntriesToMarkdown(header, entries);
  }

  if (output) {
    const outputPath = path.resolve(
      output.startsWith("~") ? output.replace("~", process.env.HOME ?? "") : output,
    );
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, result, "utf-8");
    console.log(`Exported session "${sessionKey}" to ${outputPath}`);
  } else {
    process.stdout.write(result);
  }
}
