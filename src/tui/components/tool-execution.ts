// Tool execution component renders compact user-visible progress in the TUI.
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { markdownTheme, theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";

// Rendering model for live tool calls in the chat log.
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

// Prefer curated display summaries, then fall back to sanitized JSON args.
function formatArgs(toolName: string, args: unknown): string {
  const display = resolveToolDisplay({ name: toolName, args });
  const detail = formatToolDetail(display);
  if (detail) {
    return sanitizeRenderableText(detail);
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    return sanitizeRenderableText(JSON.stringify(args));
  } catch {
    return "";
  }
}

function getToolArgString(args: unknown, key: string): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function unwrapBashCommand(rawCommand: string): string {
  let command = rawCommand.trim();
  const bashMatch = /^\/?[\w/.-]*bash\s+-lc\s+([\s\S]+)$/u.exec(command);
  if (bashMatch?.[1]) {
    command = bashMatch[1].trim();
  }
  if (
    (command.startsWith("'") && command.endsWith("'")) ||
    (command.startsWith('"') && command.endsWith('"'))
  ) {
    command = command.slice(1, -1).trim();
  }
  return command;
}

function normalizeCommandForNode(command: string): string {
  return command
    .replace(/^timeout\s+\d+[a-z]?\s+/iu, "")
    .replace(/^bash\s+-n\s+pm\s*&&\s*/iu, "")
    .trim();
}

const CONTROL_NODE_LABELS: Record<string, string> = {
  created: "创建 run",
  task_pack: "生成/读取任务契约",
  context_route: "上下文路由",
  context_pack: "装配上下文包",
  capability_select: "选择 runner/model/权限",
  workspace_bind: "绑定工作区",
  dispatch: "派发给 runner",
  runner_active: "runner 执行中",
  file_change_detected: "发现文件变更",
  command_run: "执行验证命令",
  verify: "验证结果",
  collect_result: "收集 result/metrics/evidence",
  promotion_scan: "扫描沉淀候选",
  completed: "完成",
  blocked: "阻塞",
  failed: "失败",
};

type ControlNode = {
  nodeId: string;
  detail?: string;
};

function formatControlNode(nodeId: string, detail?: string): string {
  const label = CONTROL_NODE_LABELS[nodeId] ?? nodeId;
  return detail ? `${label}：${detail}` : label;
}

function resolvePmNode(command: string, isPartial: boolean, isError: boolean): ControlNode | null {
  const validateMatch = /(?:^|\s)\.\/pm\s+validate\s+([A-Za-z0-9_-]+)/u.exec(command);
  if (validateMatch?.[1]) {
    if (isError) {
      return { nodeId: "failed", detail: validateMatch[1] };
    }
    return {
      nodeId: isPartial ? "command_run" : "verify",
      detail: validateMatch[1],
    };
  }
  if (/(?:^|\s)\.\/pm\s+(?:start|run\s+start)\b/u.test(command)) {
    return { nodeId: "created" };
  }
  if (/(?:task[_-]?pack|task\s+pack|contract|prepare(?:\s+run)?)/iu.test(command)) {
    return { nodeId: "task_pack" };
  }
  if (/(?:context[_-]?route|context\s+route|route\s+context|context-routes)/iu.test(command)) {
    return { nodeId: "context_route" };
  }
  if (/(?:context[_-]?pack|context\s+pack|prepared?\s+artifacts?)/iu.test(command)) {
    return { nodeId: "context_pack" };
  }
  if (/(?:capability|model\s+strategy|runner\s+selection|permission)/iu.test(command)) {
    return { nodeId: "capability_select" };
  }
  if (/(?:workspace|bind|setup)/iu.test(command)) {
    return { nodeId: "workspace_bind" };
  }
  if (/(?:dispatch|codex|claude)/iu.test(command)) {
    return { nodeId: "dispatch" };
  }
  if (/(?:runner|execute|agent)/iu.test(command)) {
    return { nodeId: "runner_active" };
  }
  if (/(?:promotion|promote)/iu.test(command)) {
    return { nodeId: "promotion_scan" };
  }
  if (/(?:collect|result|metrics|evidence|history|status)/iu.test(command)) {
    return { nodeId: "collect_result" };
  }
  if (/(?:blocked|blocker)/iu.test(command)) {
    return { nodeId: "blocked" };
  }
  return null;
}

export function resolveControlNode(
  toolName: string,
  args: unknown,
  isPartial: boolean,
  isError: boolean,
): ControlNode | null {
  const normalizedToolName = toolName.trim().toLowerCase();
  if (isError) {
    return { nodeId: "failed" };
  }
  if (normalizedToolName === "apply_patch") {
    return { nodeId: "file_change_detected" };
  }
  if (normalizedToolName !== "bash") {
    return null;
  }
  const command = normalizeCommandForNode(unwrapBashCommand(getToolArgString(args, "command")));
  if (!command) {
    return null;
  }
  const pmNode = resolvePmNode(command, isPartial, isError);
  if (pmNode) {
    return pmNode;
  }
  if (/^git\s+(?:diff|status)\b/u.test(command)) {
    return { nodeId: "file_change_detected" };
  }
  if (/^git\s+log\b/u.test(command)) {
    return { nodeId: "collect_result" };
  }
  return null;
}

export function shouldDisplayToolExecution(
  toolName: string,
  args: unknown,
  isPartial: boolean,
  isError: boolean,
): boolean {
  return resolveControlNode(toolName, args, isPartial, isError) !== null;
}

function formatKeyNodeTitle(
  toolName: string,
  args: unknown,
  fallbackLabel: string,
  isPartial: boolean,
  isError: boolean,
): string {
  const node = resolveControlNode(toolName, args, isPartial, isError);
  return node ? formatControlNode(node.nodeId, node.detail) : fallbackLabel;
}

function stripTextFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:text|txt|log|output|stdout|stderr)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(
    trimmed,
  );
  return match?.[1] ?? text;
}

export function attachToolOutputContent(result: unknown, output: unknown): unknown {
  if (typeof output !== "string" || !output.trim()) {
    return result;
  }
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as ToolResult).content) &&
    (result as ToolResult).content!.length > 0
  ) {
    return result;
  }
  return {
    ...(result && typeof result === "object" ? (result as Record<string, unknown>) : {}),
    content: [
      {
        type: "text",
        text: output,
      },
    ],
  };
}

// Extracts visible text and compact media placeholders from tool result payloads.
function extractText(result?: ToolResult): string {
  if (!result?.content) {
    return "";
  }
  const lines: string[] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      lines.push(sanitizeRenderableText(redactToolPayloadText(stripTextFence(entry.text))));
    } else if (entry.type === "image") {
      const mime = entry.mimeType ?? "image";
      const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
      const omitted = entry.omitted ? " (omitted)" : "";
      lines.push(`[${mime}${size}${omitted}]`);
    }
  }
  return lines.join("\n").trim();
}

/** Displays a running or completed tool call with optional expandable output. */
export class ToolExecutionComponent extends Container {
  private header: Text;
  private output: Markdown;
  private toolName: string;
  private args: unknown;
  private result?: ToolResult;
  private expanded = false;
  private isError = false;
  private isPartial = true;
  readonly isToolExecutionComponent = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.header = new Text("", 0, 0);
    this.output = new Markdown("", 0, 0, markdownTheme, {
      color: (line) => theme.toolOutput(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.header);
    this.addChild(this.output);
    this.refresh();
  }

  /** Re-renders tool arguments when streaming tool call input changes. */
  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  /** Toggles preview/full output rendering for long tool results. */
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.refresh();
  }

  /** Marks the tool call complete and renders final output. */
  setResult(result: ToolResult | undefined, opts?: { isError?: boolean }) {
    this.result = result;
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  /** Renders partial output while the tool call is still running. */
  setPartialResult(result: ToolResult | undefined) {
    this.result = result;
    this.isPartial = true;
    this.refresh();
  }

  private refresh() {
    const display = resolveToolDisplay({
      name: this.toolName,
      args: this.args,
    });
    const title = `${formatKeyNodeTitle(
      this.toolName,
      this.args,
      display.label,
      this.isPartial,
      this.isError,
    )}${this.isPartial ? "…" : ""}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    const raw = extractText(this.result);
    const argLine = formatArgs(this.toolName, this.args);
    const text = this.expanded ? raw || argLine : "";
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
