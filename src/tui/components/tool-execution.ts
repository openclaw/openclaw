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
  data?: string; // base64 image data (when upstream doesn't strip it)
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
 * Process tool result content blocks in a single sequential pass.
 *
 * Tools emit images as [TEXT with MEDIA:path, IMAGE with base64] pairs.
 * When a MEDIA text block is rendered from file, `lastMediaRenderedFromFile`
 * is set so the immediately following IMAGE block (base64 duplicate) is
 * skipped. Orphan IMAGE blocks (no preceding MEDIA) render from base64.
 * This dedup approach comes from the old PR #36740 and avoids index-space
 * mismatches when MEDIA paths and image blocks are interleaved.
 */
// Short fingerprint of base64 data for cross-tool dedup. Covers the image
// header + enough pixel data to distinguish different images while staying
// cheap to compute. Two tool calls with the same file produce identical data.
function imageFingerprint(data: string): string {
  return data.slice(0, 128);
}

function processResult(
  result?: ToolResult,
  canRender?: boolean,
  globalRendered?: Set<string>,
): { images: CachedImage[]; text: string; textStripped: string } {
  const empty = { images: [], text: "", textStripped: "" };
  if (!result?.content) {
    return empty;
  }

  const images: CachedImage[] = [];
  const seenPaths = new Set<string>();
  const rawLines: string[] = [];
  const strippedLines: string[] = [];
  let lastMediaRenderedFromFile = false;

  for (const entry of result.content) {
    if (entry.type === "text" && entry.text) {
      lastMediaRenderedFromFile = false;
      rawLines.push(sanitizeRenderableText(entry.text));

      if (canRender) {
        const { text, mediaUrls } = splitMediaFromOutput(entry.text);
        if (text) {
          strippedLines.push(sanitizeRenderableText(text));
        }
        if (mediaUrls) {
          for (const mediaPath of mediaUrls) {
            if (seenPaths.has(mediaPath) || globalRendered?.has(mediaPath)) {
              continue;
            }
            seenPaths.add(mediaPath);
            globalRendered?.add(mediaPath);
            const loaded = readMediaImageAsBase64(mediaPath);
            if (loaded) {
              const fp = imageFingerprint(loaded.data);
              if (globalRendered?.has(fp)) {
                continue;
              }
              globalRendered?.add(fp);
              const filename = mediaPath.split(/[/\\]/).pop();
              images.push({
                component: createInlineImage(loaded.data, loaded.mimeType, { filename }),
                filename,
              });
              lastMediaRenderedFromFile = true;
            }
          }
        }
      }
    } else if (entry.type === "image") {
      if (canRender) {
        if (lastMediaRenderedFromFile) {
          // Already rendered from file; skip the base64 duplicate.
          lastMediaRenderedFromFile = false;
          continue;
        }
        // Orphan image block (no preceding MEDIA) - render from base64 if available
        if (entry.data && entry.mimeType && !entry.omitted) {
          const fp = imageFingerprint(entry.data);
          if (!globalRendered?.has(fp)) {
            globalRendered?.add(fp);
            images.push({
              component: createInlineImage(entry.data, entry.mimeType),
            });
          }
        }
      } else {
        const mime = entry.mimeType ?? "image";
        const size = entry.bytes ? ` ${Math.round(entry.bytes / 1024)}kb` : "";
        const omitted = entry.omitted ? " (omitted)" : "";
        rawLines.push(`[${mime}${size}${omitted}]`);
      }
      lastMediaRenderedFromFile = false;
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
  private globalRendered?: Set<string>;

  constructor(toolName: string, args: unknown, globalRendered?: Set<string>) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.globalRendered = globalRendered;
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
    // images together, with sequential dedup: when a MEDIA text block is
    // rendered from file, the next image block (base64 duplicate) is skipped.
    this.detachImages();
    const processed = processResult(result, canRenderInlineImages(), this.globalRendered);
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
