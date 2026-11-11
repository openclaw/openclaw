import { Box, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentActivityItem as AgentItemEventData } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { unwrapToolCallForDisplay } from "../../agents/tool-display-call.js";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { markdownTheme, tuiTheme as theme } from "../theme/theme.js";
import * as tuiFormatters from "../tui-formatters.js";
import { extractTuiImageSources } from "../tui-images.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";
import { MessageImages, type TuiImageRenderer } from "./message-images.js";

type ToolResult = {
  content?: {
    type?: string;
    text?: string;
    mimeType?: string;
    bytes?: number;
    omitted?: boolean;
    data?: string;
    url?: string;
    artifactId?: string;
    source?: unknown;
  }[];
  details?: Record<string, unknown>;
};

const PREVIEW_LINES = 12;
const MAX_PREVIEW_CHARS = PREVIEW_LINES * 256;

// Bound the actual wrapped Markdown, not just source newlines: a single long
// tool-output line can otherwise produce thousands of rows and stall the TUI.
class ToolOutputComponent extends HyperlinkMarkdown {
  private sourceText: string | undefined;
  private active = true;
  private renderedSource: string | undefined;
  private expanded = false;
  private literal = false;
  private literalOutput = new Text("", 0, 0);

  override setText(text: string, literal = false): void {
    const sourceText = text.trim()
      ? tuiFormatters.sanitizeTerminalControlsAndBinary(text)
      : undefined;
    if (this.sourceText === sourceText && this.literal === literal) {
      return;
    }
    this.sourceText = sourceText;
    this.literal = literal;
    this.renderedSource = undefined;
    super.invalidate();
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) {
      return;
    }
    this.expanded = expanded;
    this.renderedSource = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const previewBudget = Math.min(MAX_PREVIEW_CHARS, PREVIEW_LINES * Math.max(1, safeWidth));
    const sourceText = this.sourceText ?? (this.active ? "…" : "");
    const text = this.expanded ? sourceText : truncateUtf16Safe(sourceText, previewBudget);

    if (this.renderedSource !== text) {
      if (this.literal) {
        this.literalOutput.setText(theme.toolOutput(text));
      } else {
        super.setText(text);
      }
      this.renderedSource = text;
    }

    const lines = this.literal
      ? this.literalOutput.render(safeWidth).map(tuiFormatters.isolateRtlRenderedLine)
      : super.render(safeWidth);
    if (this.expanded || (text.length === sourceText.length && lines.length <= PREVIEW_LINES)) {
      return lines;
    }
    return [...lines.slice(0, PREVIEW_LINES - 1), truncateToWidth("…", safeWidth, "")];
  }
}

// Prefer curated display summaries, then fall back to sanitized JSON args.
function formatArgs(detail: string | undefined, args: unknown): string {
  if (detail) {
    return tuiFormatters.sanitizeRenderableText(detail);
  }
  if (!args || typeof args !== "object") {
    return "";
  }
  try {
    return tuiFormatters.sanitizeRenderableText(JSON.stringify(args));
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
  return lines.join("\n");
}

function isCodeModeResult(toolName: string, result?: ToolResult): boolean {
  if (toolName !== "exec" && toolName !== "wait") {
    return false;
  }
  const visibleTools = asOptionalObjectRecord(result?.details?.telemetry)?.visibleTools;
  return (
    Array.isArray(visibleTools) &&
    visibleTools.length === 2 &&
    visibleTools[0] === "exec" &&
    visibleTools[1] === "wait"
  );
}

/** Displays a running or completed tool call with optional expandable output. */
export class ToolExecutionComponent extends Container {
  private box = new Box(1, 1, theme.toolPendingBg);
  private header = new Text("", 0, 0);
  private argsLine = new Text("", 0, 0);
  private output = new ToolOutputComponent("", 0, 0, markdownTheme, {
    color: (line) => theme.toolOutput(line),
  });
  private title = "";
  private isPartial = true;
  private isError = false;
  private images: MessageImages;
  private activity?: AgentItemEventData | null;
  private expanded = false;

  constructor(
    private readonly toolName: string,
    args: unknown,
    imageRenderer?: TuiImageRenderer,
  ) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.box.addChild(this.header);
    this.box.addChild(this.argsLine);
    this.box.addChild(this.output);
    this.images = new MessageImages(imageRenderer);
    this.box.addChild(this.images);
    this.setArgs(args);
    this.setResult(undefined, { partial: true });
  }

  setArgs(args: unknown) {
    const call = unwrapToolCallForDisplay({ name: this.toolName, args });
    const display = resolveToolDisplay(call);
    this.title = display.label;
    this.refreshTitle();
    const questions = asOptionalObjectRecord(call.args)?.questions;
    const questionText =
      display.name === "ask_user" && Array.isArray(questions)
        ? questions
            .slice(0, 3)
            .flatMap((raw) => {
              const question = asOptionalObjectRecord(raw);
              const options = question?.options;
              return [normalizeOptionalString(question?.question)].concat(
                Array.isArray(options)
                  ? options.slice(0, 4).map((option, index) => {
                      const label = normalizeOptionalString(asOptionalObjectRecord(option)?.label);
                      return label ? `${index + 1}. ${label}` : undefined;
                    })
                  : [],
              );
            })
            .filter(Boolean)
            .join("\n")
        : undefined;
    const argLine = formatArgs(questionText || formatToolDetail(display), args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.output.setExpanded(expanded);
  }

  get isActive() {
    return this.activity ? this.activity.phase !== "end" : this.isPartial;
  }

  setActivity(activity: AgentItemEventData | null) {
    this.activity = activity;
    this.refreshResult();
  }

  override render(width: number): string[] {
    if (
      !this.expanded &&
      (this.activity === null ||
        this.activity?.hideFromChannelProgress ||
        this.activity?.suppressChannelProgress)
    ) {
      return [];
    }
    return super.render(width);
  }

  setResult(result: ToolResult | undefined, opts?: { isError?: boolean; partial?: boolean }) {
    this.isPartial = Boolean(opts?.partial);
    this.isError = !this.isPartial && Boolean(opts?.isError);
    this.refreshResult();
    // Code Mode JSON is literal data; prose normalization can change values and escapes.
    this.output.setText(extractText(result), isCodeModeResult(this.toolName, result));
    this.images.setImages(extractTuiImageSources(result));
  }

  dispose() {
    this.images.dispose();
  }

  private refreshTitle() {
    const title = tuiFormatters.sanitizeRenderableLine(
      this.activity
        ? `${this.activity.title}${this.activity.status ? ` (${this.activity.status})` : ""}`
        : `${this.title}${this.isPartial ? " (running)" : ""}`,
    );
    this.header.setText(theme.toolTitle(theme.bold(title)));
  }

  private refreshResult() {
    this.refreshTitle();
    const status = this.activity?.status;
    this.box.setBgFn(
      this.isActive
        ? theme.toolPendingBg
        : this.activity
          ? status === "failed"
            ? theme.toolErrorBg
            : status === "completed"
              ? theme.toolSuccessBg
              : undefined
          : this.isError
            ? theme.toolErrorBg
            : theme.toolSuccessBg,
    );
    this.output.setActive(this.isActive);
  }
}
