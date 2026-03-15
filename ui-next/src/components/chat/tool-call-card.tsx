import {
  Wrench,
  ChevronDown,
  ChevronRight,
  Check,
  Eye,
  Zap,
  ExternalLink,
  X,
  ZoomIn,
  FileText,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import { cn } from "@/lib/utils";
import type { ChatMessageContent, MessageUsage } from "@/store/chat-store";

/** Threshold below which tool result text is shown inline (not collapsed). */
const INLINE_THRESHOLD = 80;

/** Max lines shown in collapsed preview. */
const PREVIEW_MAX_LINES = 2;

/** Max characters shown in collapsed preview. */
const PREVIEW_MAX_CHARS = 100;

/** Minimum tool cards to trigger aggregate summary mode. */
const AGGREGATE_THRESHOLD = 3;

export type ToolDisplayMode = "expanded" | "collapsed" | "hidden";

export type ToolCardData = {
  kind: "call" | "result";
  name: string;
  args?: unknown;
  text?: string;
  /** One-line summary extracted from tool args (e.g., the command or file path). */
  detail?: string;
  /** For call cards: merged result text from the following tool result message.
   *  undefined = no result merged yet, "" = empty result (no output). */
  resultText?: string;
};

// ─── Workspace File Preview Detection ───

const READ_IMAGE_RE = /^Read image file \[image\/(png|jpeg|gif|webp|svg\+xml)\]$/;

/** File extensions we can preview inline. */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const MARKDOWN_EXTENSION = /\.(?:md|mdx|markdown)$/i;

type FilePreview = { kind: "image" | "pdf" | "markdown"; url: string; fileName?: string };

/**
 * Build a workspace file URL from an agent ID and a file path.
 * Handles both relative paths and absolute paths under the workspace.
 * Supports both default workspace (~/.openclaw/workspace/) and
 * agent-scoped workspace (~/.openclaw/agents/{id}/workspace/).
 */
export function buildWorkspaceFileUrl(agentId: string, filePath: string): string {
  // Strip home directory prefixes for URL construction.
  let relativePath = filePath
    // Agent-scoped workspace: ~/.openclaw/agents/{id}/workspace/
    .replace(/^~\/\.openclaw\/agents\/[^/]+\/workspace\//, "")
    .replace(/^\/[^/]+\/[^/]+\/\.openclaw\/agents\/[^/]+\/workspace\//, "")
    // Default workspace: ~/.openclaw/workspace/
    .replace(/^~\/\.openclaw\/workspace\//, "")
    .replace(/^\/[^/]+\/[^/]+\/\.openclaw\/workspace\//, "");
  // If still absolute, use basename as a safe fallback.
  if (relativePath.startsWith("/")) {
    relativePath = relativePath.split("/").pop() ?? relativePath;
  }
  return `/api/workspace-files/${encodeURIComponent(agentId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Detect if a tool card has a workspace file that can be previewed inline.
 * Returns the file URL and kind (image/pdf) if applicable, undefined otherwise.
 */
function resolveToolFilePreview(card: ToolCardData, agentId?: string): FilePreview | undefined {
  if (!agentId) {
    return undefined;
  }

  const resultText = card.resultText ?? card.text ?? "";
  const isReadTool = card.name.toLowerCase() === "read";

  // Extract file path from tool call args.
  const args = card.args as Record<string, unknown> | undefined;
  const filePath = (args?.path ?? args?.file_path) as string | undefined;
  if (!filePath) {
    return undefined;
  }

  // Image read results: "Read image file [image/png]"
  if (isReadTool && READ_IMAGE_RE.test(resultText.trim()) && IMAGE_EXTENSIONS.test(filePath)) {
    return { kind: "image", url: buildWorkspaceFileUrl(agentId, filePath) };
  }

  // PDF: any tool that references a .pdf workspace file
  if (PDF_EXTENSION.test(filePath)) {
    return { kind: "pdf", url: buildWorkspaceFileUrl(agentId, filePath) };
  }

  // Markdown: any tool that references a .md workspace file
  if (MARKDOWN_EXTENSION.test(filePath)) {
    const fileName = filePath.split("/").pop() ?? filePath;
    return { kind: "markdown", url: buildWorkspaceFileUrl(agentId, filePath), fileName };
  }

  return undefined;
}

// ─── Tool Detail Resolution ───

/** Detail keys for common tools: maps tool name → arg field paths for one-line summary. */
const TOOL_DETAIL_KEYS: Record<string, string[]> = {
  bash: ["command"],
  exec: ["command"],
  process: ["sessionId"],
  read: ["path"],
  write: ["path"],
  edit: ["path"],
  attach: ["path", "url", "fileName"],
  web_fetch: ["url", "targetUrl"],
  web_search: ["query"],
  fetch: ["url"],
};

/** Fallback detail keys tried when a tool has no specific config. */
const FALLBACK_DETAIL_KEYS = [
  "command",
  "path",
  "url",
  "targetUrl",
  "query",
  "pattern",
  "name",
  "id",
  "ref",
  "element",
  "to",
  "channelId",
];

/** Shorten /Users/xxx and /home/xxx paths to ~. */
function shortenHome(s: string): string {
  return s.replace(/\/Users\/[^/]+/g, "~").replace(/\/home\/[^/]+/g, "~");
}

/** Look up a value by dot-path in an object (e.g., "request.kind"). */
function lookupPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Coerce a value to a short display string. */
function toDisplayValue(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
    if (!firstLine) {
      return undefined;
    }
    return firstLine.length > 120 ? firstLine.slice(0, 117) + "\u2026" : firstLine;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(toDisplayValue).filter(Boolean);
    if (items.length === 0) {
      return undefined;
    }
    const preview = items.slice(0, 3).join(", ");
    return items.length > 3 ? preview + "\u2026" : preview;
  }
  return undefined;
}

/** Resolve a one-line detail summary from tool name and args. */
function resolveToolDetail(name: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const key = name.toLowerCase();
  const record = args as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.trim() : undefined;

  const detailKeys = TOOL_DETAIL_KEYS[key] ?? FALLBACK_DETAIL_KEYS;
  let detail: string | undefined;

  for (const dk of detailKeys) {
    const value = lookupPath(record, dk);
    const display = toDisplayValue(value);
    if (display) {
      detail = shortenHome(display);
      break;
    }
  }

  if (action && detail) {
    return `${action} \u00b7 ${detail}`;
  }
  if (action) {
    return action;
  }
  return detail;
}

/** Extract tool call and tool result cards from a message's content array. */
export function extractToolCards(content: string | ChatMessageContent[]): ToolCardData[] {
  if (typeof content === "string") {
    return [];
  }

  const cards: ToolCardData[] = [];

  for (const block of content) {
    const kind = (typeof block.type === "string" ? block.type : "").toLowerCase();

    // Tool call / tool_use blocks
    if (
      kind === "tool_use" ||
      kind === "tool_call" ||
      kind === "tooluse" ||
      kind === "toolcall" ||
      (typeof block.name === "string" && block.input != null)
    ) {
      const callName = (block.name as string) ?? "tool";
      const callArgs = block.input ?? block.arguments ?? block.args;
      cards.push({
        kind: "call",
        name: callName,
        args: callArgs,
        detail: resolveToolDetail(callName, callArgs),
      });
    }

    // Tool result blocks
    if (kind === "tool_result" || kind === "toolresult") {
      const text =
        typeof block.content === "string"
          ? block.content
          : typeof block.text === "string"
            ? block.text
            : undefined;
      cards.push({
        kind: "result",
        name: (block.name as string) ?? (block.tool_use_id as string) ?? "tool",
        text,
      });
    }
  }

  return cards;
}

/**
 * Get a truncated preview of tool output text.
 * Shows first N lines or N characters, whichever is shorter.
 */
function getTruncatedPreview(text: string): string {
  const allLines = text.split("\n");
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join("\n");
  if (preview.length > PREVIEW_MAX_CHARS) {
    return preview.slice(0, PREVIEW_MAX_CHARS) + "\u2026";
  }
  return lines.length < allLines.length ? preview + "\u2026" : preview;
}

/** Format an arguments value for display. */
function formatArgs(args: unknown): string {
  if (args == null) {
    return "";
  }
  if (typeof args === "string") {
    // Try parsing as JSON for pretty-print
    const trimmed = args.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return args;
      }
    }
    return args;
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return JSON.stringify(args);
  }
}

/** Markdown file lightbox: fetches content and renders in a modal. */
function MarkdownLightbox({
  url,
  fileName,
  onClose,
}: {
  url: string;
  fileName: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(url)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`${r.status}`);
        }
        return r.text();
      })
      .then(setContent)
      .catch(() => setError(true));
  }, [url]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
      <div
        className="bg-card border border-border rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] w-[800px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50 shrink-0">
          <span className="text-sm font-medium text-foreground truncate">{fileName}</span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors shrink-0 ml-3"
          >
            <ExternalLink className="h-3 w-3" />
            Raw
          </a>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 prose prose-sm prose-chat max-w-none">
          {error && <p className="text-destructive text-sm">Failed to load file</p>}
          {content === null && !error && (
            <p className="text-muted-foreground text-sm">Loading...</p>
          )}
          {content !== null && <Markdown>{content}</Markdown>}
        </div>
      </div>
    </div>
  );
}

/** Inline preview for workspace files (images, PDFs, markdown) with interactive viewing. */
function WorkspaceFilePreview({ preview, alt }: { preview: FilePreview; alt?: string }) {
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  if (failed) {
    return null;
  }

  // Markdown: show a compact clickable card, lightbox fetches + renders content.
  if (preview.kind === "markdown") {
    const title = preview.fileName ?? alt ?? "Markdown file";
    return (
      <>
        <div className="border-t border-border/50 px-3 py-2">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors cursor-pointer w-full text-left"
          >
            <FileText className="h-4 w-4 text-primary/60 shrink-0" />
            <span className="text-xs font-medium text-foreground truncate">{title}</span>
            <span className="ml-auto text-[10px] text-muted-foreground shrink-0">Preview</span>
          </button>
        </div>
        {lightboxOpen && (
          <MarkdownLightbox
            url={preview.url}
            fileName={title}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    );
  }

  if (preview.kind === "pdf") {
    const title = alt ?? "PDF";
    return (
      <div className="border-t border-border/50">
        <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
          <span className="text-[11px] font-medium text-muted-foreground truncate">{title}</span>
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[10px] text-primary/70 hover:text-primary transition-colors shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
            Open
          </a>
        </div>
        <iframe
          src={preview.url}
          title={title}
          className="w-full border-t border-border/30"
          style={{ height: "400px" }}
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <>
      <div className="border-t border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={() => setLightboxOpen(true)}
          className="group/img rounded-md border border-border overflow-hidden cursor-zoom-in relative block"
        >
          <img
            src={preview.url}
            alt={alt ?? "workspace file"}
            className="max-h-64 max-w-full object-contain"
            loading="eager"
            onError={() => setFailed(true)}
          />
          <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/img:bg-black/20 transition-colors">
            <ZoomIn className="h-5 w-5 text-white opacity-0 group-hover/img:opacity-80 transition-opacity drop-shadow-md" />
          </span>
        </button>
      </div>

      {/* Lightbox overlay */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            onClick={() => setLightboxOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
          <a
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-4 right-16 z-10 rounded-full bg-black/50 p-2 text-white/80 hover:text-white hover:bg-black/70 transition-colors"
            title="Open in new tab"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-5 w-5" />
          </a>
          <img
            src={preview.url}
            alt={alt ?? "workspace file"}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

/** A single tool card: shows tool name, detail, args (collapsed), and optionally merged result. */
function ToolCard({
  card,
  onViewOutput,
  defaultExpanded = false,
  agentId,
}: {
  card: ToolCardData;
  onViewOutput?: (name: string, content: string) => void;
  /** When true, the card starts in expanded state (used in "expanded" display mode). */
  defaultExpanded?: boolean;
  /** Current agent ID, used to build workspace file URLs. */
  agentId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isCall = card.kind === "call";
  const formattedArgs = isCall ? formatArgs(card.args) : "";
  const hasArgs = isCall && formattedArgs.length > 0;
  const filePreview = resolveToolFilePreview(card, agentId);

  // Standalone result card (tool_result block within a message)
  const hasResult = !isCall && card.text != null;
  const isShort = hasResult && (card.text?.length ?? 0) <= INLINE_THRESHOLD;
  const isLong = hasResult && !isShort;

  // Merged result (call card with tool result merged in)
  const hasMergedResult = isCall && card.resultText !== undefined;
  const mergedHasContent = hasMergedResult && card.resultText!.trim().length > 0;
  const mergedIsShort = mergedHasContent && card.resultText!.length <= INLINE_THRESHOLD;
  const mergedIsLong = mergedHasContent && !mergedIsShort;

  const anyLong = isLong || mergedIsLong;
  const isExpandable = anyLong || hasArgs;

  const handleHeaderClick = () => {
    if (isExpandable) {
      setExpanded((prev) => !prev);
    }
  };

  const handleView = (e: React.MouseEvent) => {
    e.stopPropagation();
    const viewText = card.text || card.resultText;
    if (onViewOutput && viewText) {
      onViewOutput(card.name, viewText);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2",
          isExpandable && "cursor-pointer hover:bg-muted/40 transition-colors",
        )}
        onClick={handleHeaderClick}
      >
        <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground shrink-0">{card.name}</span>
        {card.detail && (
          <>
            <span className="text-muted-foreground/40 shrink-0">&middot;</span>
            <span
              className="text-[11px] text-muted-foreground/70 font-mono truncate"
              title={card.detail}
            >
              {card.detail}
            </span>
          </>
        )}

        {/* Right-side controls */}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {/* Status: standalone result with no text */}
          {!isCall && !hasResult && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Check className="h-3 w-3" />
              Completed
            </span>
          )}

          {/* Status: merged result with no output */}
          {hasMergedResult && !mergedHasContent && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Check className="h-3 w-3" />
              Completed
            </span>
          )}

          {/* View full output button for long results */}
          {anyLong && onViewOutput && (
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              onClick={handleView}
            >
              <Eye className="h-3 w-3" />
              View
            </button>
          )}

          {/* Expand/collapse chevron */}
          {isExpandable && (
            <span className="text-muted-foreground shrink-0">
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          )}
        </span>
      </div>

      {/* Arguments (collapsed by default, expand on click) */}
      {hasArgs && expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto">
            {formattedArgs}
          </pre>
        </div>
      )}

      {/* Standalone short inline result */}
      {isShort && (
        <div className="border-t border-border/50 px-3 py-2">
          <span className="text-[11px] font-mono text-muted-foreground">{card.text}</span>
        </div>
      )}

      {/* Standalone long result: truncated preview when collapsed */}
      {isLong && !expanded && (
        <div className="border-t border-border/50 px-3 py-1.5">
          <pre className="text-[11px] font-mono text-muted-foreground/70 whitespace-pre-wrap break-all leading-relaxed max-h-[44px] overflow-hidden">
            {getTruncatedPreview(card.text!)}
          </pre>
        </div>
      )}

      {/* Standalone long result: full content when expanded */}
      {isLong && expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed max-h-64 overflow-y-auto">
            {card.text}
          </pre>
        </div>
      )}

      {/* Merged short inline result */}
      {mergedIsShort && (
        <div className="border-t border-border/50 px-3 py-2">
          <span className="text-[11px] font-mono text-muted-foreground">{card.resultText}</span>
        </div>
      )}

      {/* Merged long result: truncated preview when collapsed */}
      {mergedIsLong && !expanded && (
        <div className="border-t border-border/50 px-3 py-1.5">
          <pre className="text-[11px] font-mono text-muted-foreground/70 whitespace-pre-wrap break-all leading-relaxed max-h-[44px] overflow-hidden">
            {getTruncatedPreview(card.resultText!)}
          </pre>
        </div>
      )}

      {/* Merged long result: full content when expanded */}
      {mergedIsLong && expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed max-h-64 overflow-y-auto">
            {card.resultText}
          </pre>
        </div>
      )}

      {/* Inline workspace file preview (images + PDFs) */}
      {filePreview && <WorkspaceFilePreview preview={filePreview} alt={card.detail} />}
    </div>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

export function UsageBadge({ usage, delta }: { usage: MessageUsage; delta?: number }) {
  const total = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
  if (total <= 0) {
    return null;
  }
  const parts: string[] = [];
  if (usage.input) {
    parts.push(`in: ${formatTokens(usage.input)}`);
  }
  if (usage.output) {
    parts.push(`out: ${formatTokens(usage.output)}`);
  }
  if (usage.cacheRead) {
    parts.push(`cache: ${formatTokens(usage.cacheRead)}`);
  }
  if (delta != null && delta > 0) {
    parts.push(`this turn: +${formatTokens(delta)}`);
  }
  // Only show when we have a positive delta — hide for missing, zero, or negative values
  if (delta == null || delta <= 0) {
    return null;
  }
  return (
    <span
      className="flex items-center gap-1 text-[10px] text-emerald-500/70 font-mono tabular-nums shrink-0"
      title={parts.join(" · ")}
    >
      <Zap className="h-2.5 w-2.5" />+{formatTokens(delta)}
    </span>
  );
}

/** Renders a list of tool cards with optional aggregate summary for multi-tool turns. */
export function ToolCallCard({
  cards,
  displayMode = "collapsed",
  onViewOutput,
  agentId,
}: {
  cards: ToolCardData[];
  displayMode?: ToolDisplayMode;
  onViewOutput?: (name: string, content: string) => void;
  /** Agent ID for building workspace file URLs (inline image previews). */
  agentId?: string;
}) {
  const [aggregateExpanded, setAggregateExpanded] = useState(false);

  if (cards.length === 0 || displayMode === "hidden") {
    return null;
  }

  // "expanded" mode: render every card individually with details open
  if (displayMode === "expanded") {
    return (
      <div className="flex flex-col gap-1.5">
        {cards.map((card, i) => (
          <ToolCard
            key={`${card.kind}-${card.name}-${i}`}
            card={card}
            onViewOutput={onViewOutput}
            agentId={agentId}
            defaultExpanded
          />
        ))}
      </div>
    );
  }

  // "collapsed" mode (default): aggregate when >= AGGREGATE_THRESHOLD cards
  const useAggregate = cards.length >= AGGREGATE_THRESHOLD;

  if (useAggregate && !aggregateExpanded) {
    const uniqueNames = [...new Set(cards.map((c) => c.name))];
    const summary = uniqueNames.slice(0, 4).join(", ") + (uniqueNames.length > 4 ? ", \u2026" : "");

    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-card-foreground shadow-sm cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setAggregateExpanded(true)}
      >
        <Wrench className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium text-foreground">Ran {cards.length} tools</span>
        <span className="text-[11px] text-muted-foreground truncate">{summary}</span>
        <span className="ml-auto shrink-0">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {useAggregate && (
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-0.5"
            onClick={() => setAggregateExpanded(false)}
          >
            <ChevronDown className="h-3 w-3" />
            Collapse {cards.length} tools
          </button>
        </div>
      )}
      {cards.map((card, i) => (
        <ToolCard
          key={`${card.kind}-${card.name}-${i}`}
          card={card}
          onViewOutput={onViewOutput}
          agentId={agentId}
        />
      ))}
    </div>
  );
}
