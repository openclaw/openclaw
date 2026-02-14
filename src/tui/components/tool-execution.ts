import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import chalk from "chalk";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, theme } from "../theme/theme.js";

type ToolResultContent = {
  type?: string;
  text?: string;
  mimeType?: string;
  bytes?: number;
  omitted?: boolean;
};

type ToolResult = {
  content?: ToolResultContent[];
  details?: Record<string, unknown>;
};

const PREVIEW_LINES = 12;

function formatArgs(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  const detail = formatToolDetail(display);
  if (detail) {
    return detail;
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function extractText(result?: ToolResult): string {
  if (!result?.content) {
    return "";
  }
  const lines: string[] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      lines.push(entry.text);
    } else if (entry.type === "image") {
      const mime = entry.mimeType ?? "image";
      const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
      const omitted = entry.omitted ? " (omitted)" : "";
      lines.push(`[${mime}${size}${omitted}]`);
    }
  }
  return lines.join("\n").trim();
}

function resolveToolFamily(name: string) {
  const n = name.toLowerCase();
  if (n.includes("web")) {
    return "web";
  }
  if (
    n === "read" ||
    n === "write" ||
    n === "edit" ||
    n.includes("memory") ||
    n.includes("session")
  ) {
    return "files";
  }
  if (n.includes("exec") || n === "process") {
    return "exec";
  }
  if (n.includes("browser") || n === "canvas") {
    return "browser";
  }
  return "other";
}

function colorFamily(text: string, family: string) {
  if (family === "web") {
    return chalk.hex("#7DD3A5")(text);
  }
  if (family === "files") {
    return chalk.hex("#8CC8FF")(text);
  }
  if (family === "exec") {
    return chalk.hex("#F2A65A")(text);
  }
  if (family === "browser") {
    return chalk.hex("#C4B5FD")(text);
  }
  return theme.toolTitle(text);
}

function formatToolElapsed(startedAt: number | null, endedAt: number | null) {
  if (!startedAt) {
    return "0.0s";
  }
  const end = endedAt ?? Date.now();
  const ms = Math.max(0, end - startedAt);
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export class ToolExecutionComponent extends Container {
  private box: Box;
  private header: Text;
  private argsLine: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: ToolResult;
  private expanded = false;
  private isError = false;
  private isPartial = true;
  private updateCount = 0;
  private startedAt: number | null;
  private endedAt: number | null = null;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.startedAt = Date.now();
    this.box = new Box(1, 1, (line) => theme.toolPendingBg(line));
    this.header = new Text("", 0, 0);
    this.argsLine = new Text("", 0, 0);
    this.output = new Markdown("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.refresh();
  }

  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.refresh();
  }

  setResult(result: ToolResult | undefined, opts?: { isError?: boolean }) {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.endedAt = Date.now();
    this.refresh();
  }

  setPartialResult(result: ToolResult | undefined) {
    this.result = result;
    this.isPartial = true;
    this.updateCount += 1;
    this.refresh();
  }

  private refresh() {
    const bg = this.isPartial
      ? theme.toolPendingBg
      : this.isError
        ? theme.toolErrorBg
        : theme.toolSuccessBg;
    this.box.setBgFn((line) => bg(line));

    const display = resolveToolDisplay({
      name: this.toolName,
      args: this.args,
    });

    const raw = extractText(this.result);
    const isCached = /\bcache(?:d| hit)?\b/i.test(raw);
    const badge = this.isPartial ? "running" : this.isError ? "error" : isCached ? "cached" : "ok";
    const family = resolveToolFamily(this.toolName);
    const elapsed = formatToolElapsed(this.startedAt, this.endedAt);

    const title = `${display.emoji} ${display.label} [${badge}] [${family}] [${elapsed}]`;
    this.header.setText(colorFamily(theme.bold(title), family));

    const timeline = `timeline: start → args${this.updateCount > 0 ? ` → updates x${this.updateCount}` : ""}${this.isPartial ? "" : " → result"}`;
    const argLine = formatArgs(this.toolName, this.args);
    this.argsLine.setText(theme.dim(`${timeline}${argLine ? ` | ${argLine}` : ""}`));

    const text = raw || (this.isPartial ? "…" : "");
    if (!this.expanded && text) {
      const lines = text.split("\n");
      const preview =
        lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }
  }
}
