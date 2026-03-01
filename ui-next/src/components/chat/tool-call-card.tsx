import { Wrench, ChevronDown, ChevronRight, Check, Eye } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessageContent } from "@/store/chat-store";

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

/** A single tool card: shows tool name, detail, args (collapsed), and optionally merged result. */
function ToolCard({
  card,
  onViewOutput,
  defaultExpanded = false,
}: {
  card: ToolCardData;
  onViewOutput?: (name: string, content: string) => void;
  /** When true, the card starts in expanded state (used in "expanded" display mode). */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const isCall = card.kind === "call";
  const formattedArgs = isCall ? formatArgs(card.args) : "";
  const hasArgs = isCall && formattedArgs.length > 0;

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

        {/* Status: standalone result with no text */}
        {!isCall && !hasResult && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <Check className="h-3 w-3" />
            Completed
          </span>
        )}

        {/* Status: merged result with no output */}
        {hasMergedResult && !mergedHasContent && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
            <Check className="h-3 w-3" />
            Completed
          </span>
        )}

        {/* View full output button for long results */}
        {anyLong && onViewOutput && (
          <button
            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleView}
          >
            <Eye className="h-3 w-3" />
            View
          </button>
        )}

        {/* Expand/collapse chevron */}
        {isExpandable && (
          <span
            className={cn(
              "text-muted-foreground shrink-0",
              !(anyLong && onViewOutput) && "ml-auto",
            )}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        )}
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
    </div>
  );
}

/** Renders a list of tool cards with optional aggregate summary for multi-tool turns. */
export function ToolCallCard({
  cards,
  displayMode = "collapsed",
  onViewOutput,
}: {
  cards: ToolCardData[];
  displayMode?: ToolDisplayMode;
  onViewOutput?: (name: string, content: string) => void;
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
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {useAggregate && (
        <button
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors mb-0.5 self-start"
          onClick={() => setAggregateExpanded(false)}
        >
          <ChevronDown className="h-3 w-3" />
          Collapse {cards.length} tools
        </button>
      )}
      {cards.map((card, i) => (
        <ToolCard key={`${card.kind}-${card.name}-${i}`} card={card} onViewOutput={onViewOutput} />
      ))}
    </div>
  );
}
