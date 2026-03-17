import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { Image } from "@mariozechner/pi-tui";
import { formatToolDetail, resolveToolDisplay } from "../../agents/tool-display.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { markdownTheme, theme } from "../theme/theme.js";
import { sanitizeRenderableText } from "../tui-formatters.js";
import {
  canRenderInlineImages,
  createInlineImage,
  readMediaImageAsBase64,
} from "./inline-image.js";

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

type CachedImage = { component: Image; filename?: string };

const PREVIEW_LINES = 12;

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

/**
 * Process tool result content blocks in a single pass:
 * - Extract MEDIA: paths from text blocks and load images from disk
 * - Build both raw text and media-stripped text simultaneously
 * Avoids calling splitMediaFromOutput twice per block.
 */
function processResult(
  result?: ToolResult,
  canRender?: boolean,
): { images: CachedImage[]; text: string; textStripped: string } {
  const empty = { images: [], text: "", textStripped: "" };
  if (!result?.content) {
    return empty;
  }

  const images: CachedImage[] = [];
  const seenPaths = new Set<string>();
  const rawLines: string[] = [];
  const strippedLines: string[] = [];

  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      rawLines.push(sanitizeRenderableText(entry.text));

      if (canRender) {
        const { text, mediaUrls } = splitMediaFromOutput(entry.text);
        if (text) {
          strippedLines.push(sanitizeRenderableText(text));
        }
        if (mediaUrls) {
          for (const mediaPath of mediaUrls) {
            if (seenPaths.has(mediaPath)) {
              continue;
            }
            seenPaths.add(mediaPath);
            const loaded = readMediaImageAsBase64(mediaPath);
            if (loaded) {
              const filename = mediaPath.split(/[/\\]/).pop();
              images.push({
                component: createInlineImage(loaded.data, loaded.mimeType, { filename }),
                filename,
              });
            }
          }
        }
      }
    } else if (entry.type === "image") {
      if (!canRender) {
        const mime = entry.mimeType ?? "image";
        const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
        const omitted = entry.omitted ? " (omitted)" : "";
        rawLines.push(`[${mime}${size}${omitted}]`);
      }
    }
  }

  const text = rawLines.join("\n").trim();
  const hasImages = images.length > 0;
  const textStripped = hasImages ? strippedLines.join("\n").trim() : text;
  return { images, text, textStripped };
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

  // Cached image data - loaded once in setResult(), reused across refreshes.
  // This avoids synchronous file I/O in the render path.
  private cachedImages: CachedImage[] = [];
  private cachedText = "";
  private cachedTextStripped = "";
  private imagesAttached = false;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
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

    // All I/O happens here, NOT in refresh(). Single-pass processes text and
    // images together to avoid calling splitMediaFromOutput twice per block.
    this.detachImages();
    const processed = processResult(result, canRenderInlineImages());
    this.cachedImages = processed.images;
    this.cachedText = processed.text;
    this.cachedTextStripped = processed.textStripped;

    this.refresh();
  }

  setPartialResult(result: ToolResult | undefined) {
    this.result = result;
    this.isPartial = true;
    // Clear any cached images from a prior setResult() to prevent stale state
    this.detachImages();
    this.cachedImages = [];
    this.cachedText = processResult(result, false).text;
    this.cachedTextStripped = this.cachedText;
    this.refresh();
  }

  /** Remove image components from the box without destroying cached data. */
  private detachImages() {
    if (!this.imagesAttached) {
      return;
    }
    for (const img of this.cachedImages) {
      this.box.removeChild(img.component);
    }
    this.imagesAttached = false;
  }

  /** Attach cached image components to the box. */
  private attachImages() {
    if (this.imagesAttached || this.cachedImages.length === 0) {
      return;
    }
    for (const img of this.cachedImages) {
      this.box.addChild(img.component);
    }
    this.imagesAttached = true;
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
    const title = `${display.emoji} ${display.label}${this.isPartial ? " (running)" : ""}`;
    this.header.setText(theme.toolTitle(theme.bold(title)));

    const argLine = formatArgs(this.toolName, this.args);
    this.argsLine.setText(argLine ? theme.dim(argLine) : theme.dim(" "));

    // Use pre-cached text (with or without MEDIA: lines stripped).
    // refresh() does zero I/O - all data was loaded in setResult().
    const renderImages = !this.isPartial && this.cachedImages.length > 0;
    const raw = renderImages ? this.cachedTextStripped : this.cachedText;
    const text = raw || (this.isPartial ? "…" : "");

    if (!this.expanded && text) {
      const lines = text.split("\n");
      const preview =
        lines.length > PREVIEW_LINES ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n…` : text;
      this.output.setText(preview);
    } else {
      this.output.setText(text);
    }

    // Attach/detach stable Image components - no recreation, no I/O
    if (renderImages) {
      this.attachImages();
    } else {
      this.detachImages();
    }
  }
}
