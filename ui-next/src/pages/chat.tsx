import {
  Bot,
  Copy,
  Check,
  RefreshCw,
  Square,
  Search,
  Plus,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  RotateCcw,
  Paperclip,
  Mic,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ArrowUp,
  FileText,
  Code2,
  Paintbrush,
  BookOpen,
  Menu,
  ThumbsUp,
  ThumbsDown,
  Brain,
  Image,
  X,
  ChevronsLeft,
  ChevronsRight,
  EyeOff,
  Wrench,
  Reply,
  Hash,
  Pencil,
  User,
  Volume2,
  VolumeOff,
  Zap,
  Minimize2,
  Pause,
  Play,
  ListPlus,
} from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  ToolCallCard,
  extractToolCards,
  type ToolDisplayMode,
} from "@/components/chat/tool-call-card";
import { Button } from "@/components/ui/button";
import { ChatContainer } from "@/components/ui/custom/prompt/chat-container";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from "@/components/ui/custom/prompt/input";
import { TextShimmerLoader } from "@/components/ui/custom/prompt/loader";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import { PromptScrollButton } from "@/components/ui/custom/prompt/scroll-button";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useChat } from "@/hooks/use-chat";
import { useDynamicPlaceholder } from "@/hooks/use-dynamic-placeholder";
import { useGateway } from "@/hooks/use-gateway";
import { loadSettings, saveSettings } from "@/lib/storage";
import { cn } from "@/lib/utils";
import {
  useChatStore,
  getMessageText,
  getMessageImages,
  type ChatMessage,
  type SessionEntry,
  type DraftAttachment,
} from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

/** Stable empty array for zustand selector fallback (avoids infinite re-render). */
const EMPTY_ATTACHMENTS: DraftAttachment[] = [];

let attachmentIdCounter = 0;

/** Read a File as a base64 data URL string. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Extract the raw base64 data (without the data: prefix) from a data URL. */
function extractBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// ─── Helpers ───

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

function formatContextWindow(tokens?: number): string {
  if (!tokens) {
    return "";
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(0)}k`;
  }
  return String(tokens);
}

/** Strip leading bracketed prefix (e.g., "[Fri 2026-02-13 20:20 GMT+5:30]") from strings. */
function stripBracketedPrefix(s: string): string {
  const stripped = s.replace(/^\[[^\]]*\]\s*/, "");
  return stripped.trim() || s;
}

function formatSessionTitle(session: SessionEntry): string {
  // User-set label takes priority
  if (session.label) {
    return session.label;
  }

  // Server-derived title, with datetime prefix cleaned
  if (session.derivedTitle) {
    return stripBracketedPrefix(session.derivedTitle);
  }

  // Try extracting meaningful content from the key (strip datetime prefix)
  const keyContent = stripBracketedPrefix(session.key);
  if (keyContent !== session.key && keyContent.length > 0) {
    return keyContent;
  }

  // Use lastMessage as a descriptive fallback
  if (session.lastMessage) {
    return session.lastMessage.trim();
  }

  // Final fallback: clean up key for display
  const key = session.key;
  if (key.includes(":")) {
    const parts = key.split(":");
    return parts[parts.length - 1] || key;
  }
  return key;
}

function groupSessionsByTime(sessions: SessionEntry[]): Record<string, SessionEntry[]> {
  const now = Date.now();
  const day = 86400000;
  const groups: Record<string, SessionEntry[]> = {};

  for (const s of sessions) {
    const lastActive = s.lastActiveMs ?? 0;
    const age = now - lastActive;
    let group: string;
    if (age < day) {
      group = "Today";
    } else if (age < 2 * day) {
      group = "Yesterday";
    } else if (age < 7 * day) {
      group = "7 Days Ago";
    } else {
      group = "Older";
    }

    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(s);
  }

  return groups;
}

// ─── Clipboard hook ───

function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

// ─── Message Grouping ───

/**
 * Determine whether a message is the first in a consecutive group of the same
 * effective role. Tool messages are treated as "assistant" for grouping purposes
 * (they always follow assistant tool_use blocks).
 */
function isFirstInGroup(messages: ChatMessage[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  const cur = messages[index];
  const prev = messages[index - 1];
  const effectiveRole = (role: string) =>
    role === "tool" || role === "toolResult" ? "assistant" : role;
  return effectiveRole(cur.role) !== effectiveRole(prev.role);
}

// ─── Thinking Extraction ───

const THINKING_RE = /<thinking>([\s\S]*?)<\/thinking>/gi;

/**
 * Extract thinking content from an assistant message.
 * Handles both inline `<thinking>` tags in text and structured content blocks
 * where `type === "thinking"`.
 */
function extractThinking(msg: ChatMessage): { thinking: string | null; content: string } {
  // Check for structured thinking blocks in content arrays
  if (Array.isArray(msg.content)) {
    const thinkingBlocks: string[] = [];
    const otherBlocks: typeof msg.content = [];

    for (const block of msg.content) {
      if (block.type === "thinking" && typeof block.text === "string") {
        thinkingBlocks.push(block.text);
      } else {
        otherBlocks.push(block);
      }
    }

    if (thinkingBlocks.length > 0) {
      const textContent = otherBlocks
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("");
      return { thinking: thinkingBlocks.join("\n\n"), content: textContent };
    }
  }

  // Fall back to regex extraction from text
  const text = getMessageText(msg);
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  // Reset lastIndex since the regex is global
  THINKING_RE.lastIndex = 0;
  while ((match = THINKING_RE.exec(text)) !== null) {
    matches.push(match[1].trim());
  }

  if (matches.length === 0) {
    return { thinking: null, content: text };
  }

  const stripped = text.replace(THINKING_RE, "").trim();
  return { thinking: matches.join("\n\n"), content: stripped };
}

/** Collapsible thinking section displayed above assistant message content. */
function ThinkingSection({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        <span className="font-medium">Thinking</span>
      </button>
      {expanded && (
        <div className="mt-2 pl-5 border-l-2 border-border/40">
          <p className="text-xs text-muted-foreground italic whitespace-pre-wrap leading-relaxed">
            {thinking}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Message Images ───

/** Renders inline images extracted from a message's content blocks. */
function MessageImages({ msg }: { msg: ChatMessage }) {
  const images = getMessageImages(msg);
  if (images.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {images.map((img, i) => (
        <a
          key={i}
          href={img.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg overflow-hidden border border-border/60 hover:border-primary/40 transition-colors"
        >
          <img
            src={img.url}
            alt={img.alt ?? "image"}
            className="max-w-xs max-h-64 rounded-lg object-contain"
          />
        </a>
      ))}
    </div>
  );
}

// ─── Model Selector Helpers ───

function providerColor(provider: string): string {
  switch (provider.toLowerCase()) {
    case "anthropic":
      return "text-chart-5";
    case "openai":
      return "text-chart-2";
    case "google":
      return "text-chart-1";
    default:
      return "text-muted-foreground";
  }
}

function groupModelsByProvider(models: ModelEntry[]): Record<string, ModelEntry[]> {
  const groups: Record<string, ModelEntry[]> = {};
  for (const m of models) {
    const key = m.provider || "other";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(m);
  }
  return groups;
}

// ─── Visual Components ───

function GlowingOrb() {
  return (
    <div className="relative flex h-32 w-32 items-center justify-center">
      {/* Outer glow - increased opacity for better visibility */}
      <div className="absolute inset-0 rounded-full bg-gradient-to-t from-primary/30 to-chart-2/30 blur-2xl animate-pulse" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-gray-900 to-black shadow-2xl border border-white/10 flex items-center justify-center overflow-hidden ring-1 ring-white/10">
        <div className="absolute inset-0 bg-gradient-to-tr from-primary/30 via-transparent to-chart-2/30 opacity-60" />
        {/* Inner shine */}
        <div className="absolute -top-4 -left-4 h-12 w-12 rounded-full bg-primary/30 blur-xl" />
        <Bot className="h-8 w-8 text-primary relative z-10" />
      </div>
    </div>
  );
}

// ─── Message Bubble ───

function ChatMessageBubble({
  msg,
  index,
  rating,
  isLastAssistant,
  isGroupFirst = true,
  toolDisplayMode = "collapsed",
  mergedToolResults,
  onRate,
  onRegenerate,
  onViewToolOutput,
  onReply,
  onCopyId,
}: {
  msg: ChatMessage;
  index: number;
  rating?: "up" | "down" | null;
  isLastAssistant: boolean;
  /** True when this message starts a new consecutive group (show avatar). */
  isGroupFirst?: boolean;
  toolDisplayMode?: ToolDisplayMode;
  /** Result texts from following tool messages, merged into this assistant's tool call cards. */
  mergedToolResults?: string[];
  onRate: (index: number, rating: "up" | "down") => void;
  onRegenerate: () => void;
  onViewToolOutput?: (name: string, content: string) => void;
  onReply?: (msg: ChatMessage) => void;
  onCopyId?: (msg: ChatMessage) => void;
}) {
  const text = getMessageText(msg);
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const isTool = msg.role === "tool" || msg.role === "toolResult";
  const { copied, copy } = useCopyToClipboard();
  const { copied: idCopied, copy: copyId } = useCopyToClipboard();

  // Check for tool call/result content blocks and merge following tool results
  const toolCards = (() => {
    const cards = extractToolCards(msg.content);
    if (!mergedToolResults || mergedToolResults.length === 0) {
      return cards;
    }
    let resultIdx = 0;
    return cards.map((card) => {
      if (card.kind === "call" && resultIdx < mergedToolResults.length) {
        const resultRaw = mergedToolResults[resultIdx++];
        const resultText =
          resultRaw && resultRaw !== "(no output)" && resultRaw.trim() ? resultRaw : "";
        return { ...card, resultText };
      }
      return card;
    });
  })();
  const hasToolCards = toolCards.length > 0;

  if (isSystem) {
    return (
      <div className="flex justify-center px-4 py-4 animate-fade-in">
        <span className="text-xs text-muted-foreground/80 bg-muted/30 px-3 py-1 rounded-full border border-border/40 font-mono">
          {text}
        </span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div
        className={cn(
          "group flex justify-end px-4 animate-slide-in",
          isGroupFirst ? "py-2" : "py-1",
        )}
      >
        <div className="max-w-[80%]">
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-5 py-3.5 shadow-lg shadow-primary/10 ring-1 ring-white/10">
            <p className="text-sm whitespace-pre-wrap leading-relaxed font-sans">{text}</p>
            <MessageImages msg={msg} />
          </div>
          {/* User message actions */}
          <div className="flex items-center justify-end gap-1 mt-1 mr-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
            {msg.seq > 0 && (
              <span className="text-[10px] text-primary/40 font-mono mr-1">#{msg.seq}</span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
              onClick={() => onReply?.(msg)}
              title="Reply"
              aria-label="Reply to message"
            >
              <Reply className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-6 w-6 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
              onClick={() => {
                copyId(`[msg #${msg.seq}]`);
                onCopyId?.(msg);
              }}
              title="Copy message ID"
              aria-label="Copy message reference"
            >
              {idCopied ? <Check className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
            </Button>
          </div>
        </div>
        {isGroupFirst ? (
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center ml-2 border border-primary/10 shrink-0">
            <User className="h-4 w-4 text-primary" />
          </div>
        ) : (
          /* Invisible spacer to keep right alignment consistent */
          <div className="w-8 ml-2 shrink-0" />
        )}
      </div>
    );
  }

  // Tool role messages (entire message is a tool result)
  // Always rendered without avatar, indented to align with assistant messages
  if (isTool) {
    // In hidden mode, suppress all tool messages entirely
    if (toolDisplayMode === "hidden") {
      return null;
    }
    if (hasToolCards) {
      return (
        <div className="px-4 py-1 animate-fade-in ml-11">
          <ToolCallCard
            cards={toolCards}
            displayMode={toolDisplayMode}
            onViewOutput={onViewToolOutput}
          />
        </div>
      );
    }
    // Filter out noisy "(no output)" markers — the preceding tool call card already shows "Completed"
    const resultText = text && text !== "(no output)" && text.trim() ? text : undefined;
    if (!resultText) {
      return null;
    }
    return (
      <div className="px-4 py-1 animate-fade-in ml-11">
        <ToolCallCard
          cards={[{ kind: "result", name: "tool", text: resultText }]}
          displayMode={toolDisplayMode}
          onViewOutput={onViewToolOutput}
        />
      </div>
    );
  }

  // Assistant message -- extract thinking and tool cards
  const { thinking, content: displayContent } = extractThinking(msg);

  // If this assistant message contains tool_use blocks, render tool cards
  // alongside any text content
  const hasText = displayContent.trim().length > 0;
  const hasError = Boolean(msg.errorMessage && msg.stopReason === "error");

  // Hide the entire bubble when tools are hidden and there's no other content
  const toolsHidden = toolDisplayMode === "hidden";
  if (toolsHidden && hasToolCards && !hasText && !hasError && !thinking) {
    return null;
  }

  return (
    <div
      className={cn("group px-4 animate-slide-in-left flex gap-3", isGroupFirst ? "py-2" : "py-1")}
    >
      {isGroupFirst ? (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20 shrink-0 mt-1">
          <Bot className="h-4 w-4 text-primary" />
        </div>
      ) : (
        /* Invisible spacer to keep left alignment consistent with avatar width */
        <div className="w-8 shrink-0" />
      )}
      <div className="max-w-[90%] md:max-w-[85%]">
        <div className="bg-card/40 text-foreground border border-border/60 rounded-2xl rounded-bl-sm px-6 py-5 shadow-sm backdrop-blur-md transition-colors group-hover:bg-card/60 group-hover:border-border/80">
          {/* Thinking section */}
          {thinking && <ThinkingSection thinking={thinking} />}

          {/* Tool cards within assistant message */}
          {hasToolCards && (
            <div className={cn(hasText && "mb-3")}>
              <ToolCallCard
                cards={toolCards}
                displayMode={toolDisplayMode}
                onViewOutput={onViewToolOutput}
              />
            </div>
          )}

          {/* Main text content */}
          {hasText && (
            <div className="prose prose-sm prose-chat max-w-none break-words leading-relaxed font-sans">
              <Markdown>{displayContent}</Markdown>
            </div>
          )}
          {/* Error message from failed model response */}
          {hasError && !hasText && (
            <p className="text-sm text-destructive/80 font-mono">{msg.errorMessage}</p>
          )}
          <MessageImages msg={msg} />
        </div>

        {/* Actions Toolbar */}
        <div className="flex items-center gap-1 mt-2 ml-1 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-y-1 group-hover:translate-y-0">
          {msg.seq > 0 && (
            <span className="text-[10px] text-primary/40 font-mono mr-1">#{msg.seq}</span>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
            onClick={() => onReply?.(msg)}
            title="Reply"
            aria-label="Reply to message"
          >
            <Reply className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
            onClick={() => {
              copyId(`[msg #${msg.seq}]`);
              onCopyId?.(msg);
            }}
            title="Copy message ID"
            aria-label="Copy message reference"
          >
            {idCopied ? <Check className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
            onClick={() => copy(displayContent || text)}
            title="Copy"
            aria-label="Copy message"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "h-7 w-7 rounded-lg transition-colors",
              rating === "up"
                ? "text-primary bg-primary/20 hover:bg-primary/30"
                : "text-primary/60 hover:text-primary hover:bg-primary/10",
            )}
            onClick={() => onRate(index, "up")}
            title="Helpful"
            aria-label="Mark as helpful"
          >
            <ThumbsUp className={cn("h-3.5 w-3.5", rating === "up" && "fill-current")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "h-7 w-7 rounded-lg transition-colors",
              rating === "down"
                ? "text-destructive bg-destructive/10 hover:bg-destructive/20"
                : "text-primary/60 hover:text-primary hover:bg-primary/10",
            )}
            onClick={() => onRate(index, "down")}
            title="Not Helpful"
            aria-label="Mark as not helpful"
          >
            <ThumbsDown className={cn("h-3.5 w-3.5", rating === "down" && "fill-current")} />
          </Button>
          {isLastAssistant && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="h-7 w-7 text-primary/60 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"
              onClick={onRegenerate}
              title="Regenerate"
              aria-label="Regenerate response"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Animated Placeholder ───

function AnimatedPlaceholder({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [displayed, setDisplayed] = useState(text);
  const [fadeState, setFadeState] = useState<"in" | "out">("in");
  const prevTextRef = useRef(text);

  // Crossfade on text change
  useEffect(() => {
    if (text === prevTextRef.current) {
      return;
    }
    // Fade out, swap text, fade in
    setFadeState("out");
    const timer = setTimeout(() => {
      setDisplayed(text);
      prevTextRef.current = text;
      setFadeState("in");
    }, 200);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <span
      className={cn(
        "text-base md:text-sm select-none transition-all duration-300 ease-in-out",
        fadeState === "out" ? "opacity-0 translate-y-1" : "opacity-100 translate-y-0",
        isStreaming
          ? "animate-shimmer bg-gradient-to-r from-primary/40 via-primary/70 to-primary/40 bg-[length:200%_100%] bg-clip-text text-transparent"
          : "text-primary/40",
      )}
    >
      {displayed}
    </span>
  );
}

// ─── Streaming Bubble ───

function StreamingBubble({
  content,
  isGroupFirst = true,
  paused = false,
}: {
  content: string;
  isGroupFirst?: boolean;
  paused?: boolean;
}) {
  return (
    <div className={cn("animate-slide-in-left flex gap-3 px-4", isGroupFirst ? "py-2" : "py-1")}>
      {isGroupFirst ? (
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20 shrink-0 mt-1">
          <Bot className="h-4 w-4 text-primary" />
        </div>
      ) : (
        <div className="w-8 shrink-0" />
      )}
      <div className="max-w-[90%] md:max-w-[85%]">
        {content ? (
          <div
            className={cn(
              "bg-card/40 text-foreground border border-border/60 rounded-2xl rounded-bl-sm px-6 py-5 shadow-sm backdrop-blur-md",
              paused && "border-chart-5/40",
            )}
          >
            <div className="prose prose-sm prose-chat max-w-none break-words leading-relaxed font-sans">
              <Markdown>{content}</Markdown>
            </div>
            {paused && (
              <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-border/40 text-[10px] text-chart-5/80 font-mono">
                <Pause className="h-2.5 w-2.5" />
                Paused
              </div>
            )}
          </div>
        ) : (
          <div className="bg-card/40 border border-border/60 rounded-2xl rounded-bl-sm px-6 py-6 shadow-sm flex items-center gap-2">
            <div className="h-2 w-2 bg-primary/50 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
            <div className="h-2 w-2 bg-primary/50 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
            <div className="h-2 w-2 bg-primary/50 rounded-full animate-bounce"></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty State ───

function EmptyState({ onSuggestionClick }: { onSuggestionClick: (text: string) => void }) {
  const suggestions = [
    { icon: FileText, label: "Summary", text: "Summarize this recent conversation" },
    { icon: Code2, label: "Code", text: "Write a React component for a dashboard" },
    { icon: Paintbrush, label: "Design", text: "Create a color palette for a fintech app" },
    { icon: BookOpen, label: "Research", text: "Find the latest trends in AI agents" },
  ];

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good Morning" : hour < 18 ? "Good Afternoon" : "Good Evening";

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 animate-fade-in relative z-10">
      <div className="mb-6">
        <GlowingOrb />
      </div>

      <div className="text-center mb-10 max-w-md">
        <h1 className="text-3xl font-medium tracking-tight mb-2">{greeting}</h1>
        <h2 className="text-xl text-muted-foreground font-light">
          How can I{" "}
          <span className="bg-gradient-to-r from-primary to-chart-2 bg-clip-text text-transparent font-normal">
            assist you today?
          </span>
        </h2>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => onSuggestionClick(s.text)}
            className="flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-card/30 hover:bg-card/80 hover:border-primary/30 transition-all duration-200 text-sm md:text-xs"
          >
            <s.icon className="h-3.5 w-3.5 text-primary" />
            <span className="text-foreground/80">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Session Sidebar ───

function SessionSidebarContent({
  onSelect,
  activeKey,
  onNewChat,
  onReset,
  onDelete,
  onRename,
  collapsed = false,
  onCollapse,
}: {
  onSelect: (key: string) => void;
  activeKey: string;
  onNewChat: () => void;
  onReset: (key: string) => void;
  onDelete: (key: string) => void;
  onRename: (key: string, newLabel: string) => void;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
}) {
  const sessions = useChatStore((s) => s.sessions);
  const loading = useChatStore((s) => s.sessionsLoading);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Close menu/confirmations when clicking outside
  useEffect(() => {
    if (menuOpen === null && confirmDelete === null && confirmReset === null) {
      return;
    }
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(null);
        setConfirmDelete(null);
        setConfirmReset(null);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [menuOpen, confirmDelete, confirmReset]);

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) {
      return sessions;
    }
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const title = formatSessionTitle(s).toLowerCase();
      const msg = (s.lastMessage ?? "").toLowerCase();
      return title.includes(q) || msg.includes(q);
    });
  }, [sessions, searchQuery]);

  const grouped = useMemo(() => groupSessionsByTime(filteredSessions), [filteredSessions]);
  const groupOrder = ["Today", "Yesterday", "7 Days Ago", "Older"];

  return (
    <div className="flex h-full flex-col bg-card/30 min-h-0">
      {/* Header with collapse toggle */}
      <div
        className={cn(
          "flex items-center border-b border-border/40 shrink-0",
          collapsed ? "justify-center px-2 py-3" : "justify-between px-4 py-3",
        )}
      >
        {!collapsed && (
          <span className="text-sm font-semibold text-foreground/80 tracking-tight">History</span>
        )}
        {onCollapse && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => onCollapse(!collapsed)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronsLeft className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        )}
      </div>

      {/* Search (hidden when collapsed) */}
      {!collapsed && (
        <div className="px-3 py-2 shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
            <input
              type="text"
              placeholder="Search chats..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search chats"
              className="h-9 w-full rounded-lg border border-border/50 bg-background/50 pl-9 pr-3 text-sm placeholder:text-muted-foreground/70 outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/10 transition-colors"
            />
          </div>
        </div>
      )}

      {/* Session list — scrollable */}
      <nav
        className={cn(
          "flex-1 overflow-y-auto min-h-0 py-1",
          collapsed ? "px-1.5" : "px-3 space-y-6",
        )}
        role="list"
        aria-label="Chat sessions"
      >
        {loading && sessions.length === 0 ? (
          <div className="px-3 py-4 text-center">
            {!collapsed && <TextShimmerLoader text="Loading..." size="sm" />}
          </div>
        ) : filteredSessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {!collapsed && (searchQuery ? "No matching chats" : "No sessions yet")}
          </div>
        ) : collapsed ? (
          /* Collapsed: icon-only session list with numbered badges */
          <div className="space-y-0.5 py-1">
            {filteredSessions.map((session, idx) => (
              <div key={session.key} className="relative group" role="listitem">
                <button
                  onClick={() => onSelect(session.key)}
                  aria-label={formatSessionTitle(session)}
                  className={cn(
                    "flex w-full items-center justify-center rounded-md py-2 transition-colors",
                    activeKey === session.key
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center h-6 w-6">
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    <span className="absolute -bottom-0.5 -right-0.5 text-[8px] font-bold leading-none bg-background rounded-full h-3 w-3 flex items-center justify-center ring-1 ring-border/50">
                      {idx + 1}
                    </span>
                  </span>
                </button>
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:block">
                  <div className="rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md whitespace-nowrap max-w-[200px] truncate">
                    {formatSessionTitle(session)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Expanded: full session list with groups */
          groupOrder.map((group) => {
            const items = grouped[group];
            if (!items?.length) {
              return null;
            }
            return (
              <div key={group}>
                <div className="px-2 mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {group}
                </div>
                <div className="space-y-0.5">
                  {items.map((session) => (
                    <div key={session.key} className="relative group/item" role="listitem">
                      <button
                        onClick={() => onSelect(session.key)}
                        className={cn(
                          "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
                          "hover:bg-accent/40",
                          activeKey === session.key
                            ? "bg-accent/60 text-foreground font-medium shadow-sm ring-1 ring-border/50"
                            : "text-muted-foreground",
                        )}
                      >
                        <MessageSquare
                          className={cn(
                            "h-4 w-4 shrink-0 transition-colors",
                            activeKey === session.key ? "text-primary" : "text-muted-foreground/70",
                          )}
                        />
                        {renamingKey === session.key ? (
                          <input
                            ref={renameInputRef}
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && renameValue.trim()) {
                                onRename(session.key, renameValue.trim());
                                setRenamingKey(null);
                              }
                              if (e.key === "Escape") {
                                setRenamingKey(null);
                              }
                            }}
                            onBlur={() => {
                              if (renameValue.trim()) {
                                onRename(session.key, renameValue.trim());
                              }
                              setRenamingKey(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 min-w-0 text-sm bg-transparent border-b border-primary/50 outline-none text-foreground placeholder:text-muted-foreground/50"
                            placeholder="Session name..."
                          />
                        ) : (
                          <span className="truncate text-sm">{formatSessionTitle(session)}</span>
                        )}
                      </button>

                      {/* Hover Menu */}
                      <div
                        ref={
                          menuOpen === session.key ||
                          confirmDelete === session.key ||
                          confirmReset === session.key
                            ? menuRef
                            : undefined
                        }
                        className={cn(
                          "absolute right-2 top-1/2 -translate-y-1/2 transition-opacity",
                          menuOpen === session.key ||
                            confirmDelete === session.key ||
                            confirmReset === session.key
                            ? "opacity-100 z-50"
                            : "opacity-0 group-hover/item:opacity-100",
                        )}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="h-6 w-6 bg-background/80 backdrop-blur-sm shadow-sm ring-1 ring-border/50"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpen(menuOpen === session.key ? null : session.key);
                            setConfirmDelete(null);
                            setConfirmReset(null);
                          }}
                          aria-label="Session options"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>

                        {menuOpen === session.key && (
                          <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-xl border border-border bg-popover/95 backdrop-blur-md p-1 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpen(null);
                                setRenamingKey(session.key);
                                setRenameValue(formatSessionTitle(session));
                                setTimeout(() => renameInputRef.current?.select(), 0);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Rename
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpen(null);
                                setConfirmReset(session.key);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-muted font-medium transition-colors"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Reset
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpen(null);
                                setConfirmDelete(session.key);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 font-medium transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          </div>
                        )}

                        {/* Inline reset confirmation */}
                        {confirmReset === session.key && (
                          <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-border/30 bg-popover/95 backdrop-blur-md p-2 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                            <p className="text-xs text-foreground mb-2 px-1">Reset this session?</p>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmReset(null);
                                }}
                                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 transition-colors text-center"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onReset(session.key);
                                  setConfirmReset(null);
                                }}
                                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-center"
                              >
                                Reset
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Inline delete confirmation */}
                        {confirmDelete === session.key && (
                          <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-xl border border-destructive/30 bg-popover/95 backdrop-blur-md p-2 shadow-lg animate-in fade-in zoom-in-95 duration-100 origin-top-right">
                            <p className="text-xs text-foreground mb-2 px-1">
                              Delete this session?
                            </p>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDelete(null);
                                }}
                                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-muted hover:bg-muted/80 transition-colors text-center"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDelete(session.key);
                                  setConfirmDelete(null);
                                }}
                                className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors text-center"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </nav>

      {/* New Chat button */}
      <div className={cn("border-t border-border/40 shrink-0", collapsed ? "px-1.5 py-2" : "p-4")}>
        {collapsed ? (
          <div className="relative group">
            <button
              onClick={onNewChat}
              className="flex w-full items-center justify-center rounded-md py-2 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
            >
              <Plus className="h-4 w-4" />
            </button>
            <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 z-50 hidden group-hover:block">
              <div className="rounded-md border bg-popover px-3 py-1.5 text-sm shadow-md whitespace-nowrap">
                New Chat
              </div>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full justify-start gap-3 rounded-xl h-11 border-dashed border-border/60 hover:border-primary/50 hover:bg-primary/5 transition-all text-muted-foreground hover:text-primary"
            onClick={onNewChat}
          >
            <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
              <Plus className="h-4 w-4" />
            </div>
            New Chat
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Chat Page ───

export function ChatPage() {
  const { sendRpc } = useGateway();
  const {
    sendMessage,
    abortRun,
    startQueue,
    stopQueue,
    switchSession,
    resetSession,
    deleteSession,
    loadSessions,
    loadHistory,
  } = useChat(sendRpc);
  const { toast } = useToast();

  const messages = useChatStore((s) => s.messages);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isPaused = useChatStore((s) => s.isPaused);
  const isSendPending = useChatStore((s) => s.isSendPending);
  const streamContent = useChatStore((s) => s.streamContent);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const messageQueue = useChatStore((s) => s.messageQueue);
  const isQueueRunning = useChatStore((s) => s.isQueueRunning);
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const placeholder = useDynamicPlaceholder();

  // Draft state from store (survives navigation)
  const inputValue = useChatStore((s) => s.drafts[s.activeSessionKey]?.inputValue ?? "");
  const setInputValue = useCallback((valOrFn: string | ((prev: string) => string)) => {
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.inputValue ?? "";
    const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
    store.setDraftInput(key, next);
  }, []);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [chatSidebarCollapsed, setChatSidebarCollapsedRaw] = useState(
    () => loadSettings().chatSidebarCollapsed,
  );
  const setChatSidebarCollapsed = useCallback((collapsed: boolean) => {
    setChatSidebarCollapsedRaw(collapsed);
    const s = loadSettings();
    s.chatSidebarCollapsed = collapsed;
    saveSettings(s);
  }, []);
  const modelSelectorRef = useRef<HTMLButtonElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Tool display mode: collapsed (default, aggregate + previews), expanded (all cards), hidden
  const [toolDisplayMode, setToolDisplayMode] = useState<ToolDisplayMode>("collapsed");

  // TTS auto mode
  type TtsAutoMode = "off" | "always" | "inbound" | "tagged";
  const TTS_MODES: TtsAutoMode[] = ["off", "always", "inbound", "tagged"];
  const [ttsMode, setTtsMode] = useState<TtsAutoMode>("off");

  // STT state
  type SttMode = "browser" | "server" | "none";
  type SttState = "idle" | "listening" | "processing";
  const [sttMode, setSttMode] = useState<SttMode>("none");
  const [sttState, setSttState] = useState<SttState>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  // Load TTS status on connect
  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendRpc<{ auto?: string }>("tts.status", {})
      .then((res) => {
        const mode = res?.auto as TtsAutoMode | undefined;
        if (mode && TTS_MODES.includes(mode)) {
          setTtsMode(mode);
        }
      })
      .catch(() => {});
  }, [isConnected, sendRpc]);

  // Detect STT availability: prefer server STT when available, fall back to browser
  useEffect(() => {
    if (!isConnected) {
      return;
    }
    sendRpc<{ available?: boolean }>("stt.status", {})
      .then((res) => {
        if (res?.available) {
          setSttMode("server");
          return;
        }
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        setSttMode(SR ? "browser" : "none");
      })
      .catch(() => {
        const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        setSttMode(SR ? "browser" : "none");
      });
  }, [isConnected, sendRpc]);

  // Cleanup STT on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      mediaRecorderRef.current?.stop();
    };
  }, []);

  const toggleStt = useCallback(() => {
    if (sttMode === "none") {
      return;
    }

    if (sttState === "listening") {
      // Stop: browser recognition or server MediaRecorder
      recognitionRef.current?.stop();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      setSttState("idle");
      setInterimTranscript("");
      return;
    }

    if (sttMode === "browser") {
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) {
        return;
      }

      const recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || "en-US";

      recognition.onstart = () => {
        setSttState("listening");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let finalText = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalText += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }

        if (finalText) {
          setInputValue((prev) => {
            const separator = prev.trim() ? " " : "";
            return prev + separator + finalText.trim();
          });
          setInterimTranscript("");
        } else {
          setInterimTranscript(interim);
        }
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        setSttState("idle");
        setInterimTranscript("");
        recognitionRef.current = null;
        switch (event.error) {
          case "not-allowed":
            toast("Microphone access denied", "error");
            break;
          case "network":
            // Chrome's SpeechRecognition sends audio to Google's cloud servers.
            // A "network" error means Google is unreachable (firewall, no internet,
            // or browser policy). Fall back to server STT if available.
            sendRpc<{ available?: boolean }>("stt.status", {})
              .then((res) => {
                if (res?.available) {
                  setSttMode("server");
                  toast("Switched to server STT (browser speech service unreachable)", "info");
                } else {
                  toast(
                    "Browser speech service unreachable. Configure a server STT provider (whisper-cpp, openai, groq) as an alternative.",
                    "error",
                  );
                }
              })
              .catch(() => {
                toast("Browser speech service unreachable", "error");
              });
            break;
          case "audio-capture":
            toast("No microphone detected", "error");
            break;
          case "service-not-allowed":
            toast("Speech recognition service not available", "error");
            break;
          case "aborted":
            // User or system aborted — no toast needed
            break;
          default:
            toast("Speech recognition failed", "error");
        }
      };

      recognition.onend = () => {
        setSttState("idle");
        setInterimTranscript("");
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
    } else if (sttMode === "server") {
      // MediaRecorder-based recording, send to server via stt.transcribe
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : "audio/webm";
          const recorder = new MediaRecorder(stream, { mimeType });
          mediaChunksRef.current = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              mediaChunksRef.current.push(e.data);
            }
          };

          recorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const blob = new Blob(mediaChunksRef.current, { type: mimeType });
            mediaChunksRef.current = [];
            if (blob.size === 0) {
              setSttState("idle");
              return;
            }
            setSttState("processing");
            setInterimTranscript("Transcribing...");
            try {
              const arrayBuf = await blob.arrayBuffer();
              const base64 = btoa(
                new Uint8Array(arrayBuf).reduce(
                  (data, byte) => data + String.fromCharCode(byte),
                  "",
                ),
              );
              const res = await sendRpc<{ text?: string }>("stt.transcribe", {
                audio: base64,
                mime: mimeType.split(";")[0],
              });
              const text = res?.text?.trim();
              if (text) {
                setInputValue((prev) => {
                  const separator = prev.trim() ? " " : "";
                  return prev + separator + text;
                });
              }
            } catch (err) {
              console.error("STT transcription failed:", err);
              toast("Transcription failed", "error");
            } finally {
              setSttState("idle");
              setInterimTranscript("");
              mediaRecorderRef.current = null;
            }
          };

          recorder.onerror = () => {
            stream.getTracks().forEach((t) => t.stop());
            setSttState("idle");
            setInterimTranscript("");
            mediaRecorderRef.current = null;
            toast("Recording failed", "error");
          };

          mediaRecorderRef.current = recorder;
          recorder.start();
          setSttState("listening");
          setInterimTranscript("Recording...");
        })
        .catch((err) => {
          console.error("Mic access error:", err);
          if (err.name === "NotAllowedError") {
            toast("Microphone access denied", "error");
          } else {
            toast("Could not access microphone", "error");
          }
        });
    }
  }, [sttMode, sttState, setInputValue, sendRpc, toast]);

  const cycleTtsMode = useCallback(() => {
    const nextIdx = (TTS_MODES.indexOf(ttsMode) + 1) % TTS_MODES.length;
    const next = TTS_MODES[nextIdx];
    setTtsMode(next);
    // Stop any ongoing speech when switching modes
    window.speechSynthesis?.cancel();
    sendRpc("config.patch", { messages: { tts: { auto: next } } }).catch(() => {});
  }, [ttsMode, sendRpc]);

  // TTS playback: speak assistant responses when streaming ends
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      return;
    }
    // Streaming just ended
    if (!wasStreamingRef.current) {
      return;
    }
    wasStreamingRef.current = false;

    if (ttsMode === "off" || !window.speechSynthesis) {
      return;
    }

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      return;
    }

    const text = getMessageText(lastMsg);
    if (!text.trim()) {
      return;
    }

    // In tagged mode, only speak if [[tts]] tag is present
    if (ttsMode === "tagged" && !text.includes("[[tts]]") && !text.includes("[[tts:")) {
      return;
    }

    // Strip markdown and [[tts]] tags for cleaner speech
    const clean = text
      .replace(/\[\[tts(?::([^\]]*))?\]\]/g, "$1")
      .replace(/#{1,6}\s+/g, "")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/`{1,3}[^`]*`{1,3}/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^[-*]\s+/gm, "")
      .replace(/\n{2,}/g, ". ")
      .trim();

    if (clean.length < 5) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, [isStreaming, messages, ttsMode]);

  // Tool output viewer panel
  const [toolOutputPanel, setToolOutputPanel] = useState<{
    open: boolean;
    name: string;
    content: string;
  }>({ open: false, name: "", content: "" });

  const handleViewToolOutput = useCallback((name: string, content: string) => {
    setToolOutputPanel({ open: true, name, content });
  }, []);

  // Reply-to state
  const [replyTo, setReplyTo] = useState<{ seq: number; role: string; preview: string } | null>(
    null,
  );

  const handleReply = useCallback((msg: ChatMessage) => {
    const msgText = getMessageText(msg);
    const lines = msgText.split("\n").slice(0, 2);
    let preview = lines.join("\n");
    if (preview.length > 150) {
      preview = preview.slice(0, 150) + "\u2026";
    } else if (msgText.split("\n").length > 2) {
      preview += "\u2026";
    }

    setReplyTo({ seq: msg.seq, role: msg.role, preview });

    // Build quote block and prepend to input
    const quoteBlock = `> [Re: #${msg.seq}] ${preview}\n\n`;
    setInputValue((prev) => {
      // If already has a quote block from a previous reply, replace it
      const stripped = prev.replace(/^> \[Re: #\d+\][\s\S]*?\n\n/, "");
      return quoteBlock + stripped;
    });

    // Focus the chat textarea
    setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
  }, []);

  const handleCopyId = useCallback((_msg: ChatMessage) => {
    // Copy already handled in the bubble via useCopyToClipboard; this is a no-op hook for future use
  }, []);

  const clearReply = useCallback(() => {
    setReplyTo(null);
    setInputValue((prev) => prev.replace(/^> \[Re: #\d+\][\s\S]*?\n\n/, ""));
  }, []);

  // Attachment state from store (survives navigation)
  // IMPORTANT: stable empty ref to avoid infinite re-render (Object.is([], []) === false)
  const attachments = useChatStore(
    (s) => s.drafts[s.activeSessionKey]?.attachments ?? EMPTY_ATTACHMENTS,
  );
  const setAttachments = useCallback((atts: DraftAttachment[]) => {
    const store = useChatStore.getState();
    store.setDraftAttachments(store.activeSessionKey, atts);
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addAttachments = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    const newAttachments: DraftAttachment[] = [];
    for (const file of imageFiles) {
      const preview = await readFileAsDataUrl(file);
      newAttachments.push({
        id: `att-${++attachmentIdCounter}`,
        preview,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
      });
    }
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.attachments ?? [];
    store.setDraftAttachments(key, [...prev, ...newAttachments]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.attachments ?? [];
    store.setDraftAttachments(
      key,
      prev.filter((a) => a.id !== id),
    );
  }, []);

  // Handle paste events to detect images
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addAttachments(imageFiles);
      }
    },
    [addAttachments],
  );

  // Handle file input change (from Paperclip button)
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) {
        return;
      }
      addAttachments(Array.from(files));
      // Reset the input so the same file can be re-selected
      e.target.value = "";
    },
    [addAttachments],
  );

  // Message ratings: map of message index -> "up" | "down"
  const [ratings, setRatings] = useState<Record<number, "up" | "down">>({});

  // Reset ratings and reply state when session changes
  useEffect(() => {
    setRatings({});
    setReplyTo(null);
  }, [activeSessionKey]);

  // Find the index of the last assistant message
  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return i;
      }
    }
    return -1;
  }, [messages]);

  // Pre-process: merge tool result messages into preceding assistant tool calls.
  // consumedIndices = tool message indices absorbed into a preceding call card.
  // mergedResults = map of assistant msg index → array of result texts from following tool msgs.
  const { consumedIndices, mergedResults } = useMemo(() => {
    const consumed = new Set<number>();
    const merged = new Map<number, string[]>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant") {
        continue;
      }

      const cards = extractToolCards(msg.content);
      if (!cards.some((c) => c.kind === "call")) {
        continue;
      }

      // Collect consecutive tool messages following this assistant message
      const results: string[] = [];
      let j = i + 1;
      while (
        j < messages.length &&
        (messages[j].role === "tool" || messages[j].role === "toolResult")
      ) {
        results.push(getMessageText(messages[j]));
        consumed.add(j);
        j++;
      }

      if (results.length > 0) {
        merged.set(i, results);
      }
    }

    return { consumedIndices: consumed, mergedResults: merged };
  }, [messages]);

  // Handle rating a message
  const handleRate = useCallback(
    (messageIndex: number, value: "up" | "down") => {
      const isToggleOff = ratings[messageIndex] === value;
      setRatings((prev) => {
        if (prev[messageIndex] === value) {
          const next = { ...prev };
          delete next[messageIndex];
          return next;
        }
        return { ...prev, [messageIndex]: value };
      });
      // Best-effort feedback RPC (may not exist yet)
      sendRpc("chat.feedback", {
        sessionKey: activeSessionKey,
        messageIndex,
        rating: isToggleOff ? null : value,
      }).catch(() => {});
    },
    [sendRpc, activeSessionKey, ratings],
  );

  // Regenerate: find last user message and resend it
  const handleRegenerate = useCallback(() => {
    if (isStreaming) {
      return;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const lastUserText = getMessageText(messages[i]);
        if (lastUserText.trim()) {
          sendMessage(lastUserText);
          return;
        }
      }
    }
  }, [messages, isStreaming, sendMessage]);

  // Load available models
  const loadModels = useCallback(async () => {
    try {
      const result = await sendRpc<{ models?: ModelEntry[] }>("models.list", {});
      setModels(result?.models ?? []);
    } catch {
      toast("Failed to load models", "error");
    }
  }, [sendRpc, toast]);

  useEffect(() => {
    if (isConnected) {
      loadModels();
    }
  }, [isConnected, loadModels]);

  // Switch model for current session (sends provider/model format for unambiguous resolution)
  const handleModelSwitch = useCallback(
    async (modelId: string, provider?: string) => {
      setModelSelectorOpen(false);
      const modelRef = provider ? `${provider}/${modelId}` : modelId;
      try {
        await sendRpc("sessions.patch", { key: activeSessionKey, model: modelRef });
        // Reload sessions to pick up the model change
        const result = await sendRpc<{ sessions: { key: string; model?: string }[] }>(
          "sessions.list",
          { limit: 50, includeDerivedTitles: true, includeLastMessage: true },
        );
        useChatStore.getState().setSessions((result?.sessions as SessionEntry[]) ?? []);
        toast("Model switched successfully", "success");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[chat] model switch failed:", err);
        toast(`Failed to switch model: ${msg}`, "error");
      }
    },
    [sendRpc, activeSessionKey, toast],
  );

  // Close model selector on Escape
  useEffect(() => {
    if (!modelSelectorOpen) {
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModelSelectorOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [modelSelectorOpen]);

  // Close model selector on click outside
  useEffect(() => {
    if (!modelSelectorOpen) {
      return;
    }
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = modelSelectorRef.current?.contains(target);
      const inDropdown = modelDropdownRef.current?.contains(target);
      if (!inTrigger && !inDropdown) {
        setModelSelectorOpen(false);
      }
    };
    const id = setTimeout(() => window.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [modelSelectorOpen]);

  // Resolve the active session's model
  const activeSession = useMemo(
    () => sessions.find((s) => s.key === activeSessionKey),
    [sessions, activeSessionKey],
  );
  const activeModel = useMemo(
    () => models.find((m) => m.id === activeSession?.model),
    [models, activeSession?.model],
  );
  // Resolve display model: session-specific model first, else first model in list
  // When neither matches, we still show activeSession?.model as raw text in the status bar
  const displayModel = activeModel ?? null;

  // Filter models to only show those from the active session's provider
  const activeProvider =
    (activeSession?.modelProvider as string | undefined) ?? displayModel?.provider;
  const filteredModels = useMemo(
    () => (activeProvider ? models.filter((m) => m.provider === activeProvider) : models),
    [models, activeProvider],
  );

  // Context window usage — gateway sends flat fields (inputTokens/outputTokens)
  const tokenUsed =
    ((activeSession?.inputTokens as number | undefined) ??
      activeSession?.tokenCounts?.totalInput ??
      0) +
    ((activeSession?.outputTokens as number | undefined) ??
      activeSession?.tokenCounts?.totalOutput ??
      0);
  const contextTotal =
    (activeSession?.contextTokens as number | undefined) ?? displayModel?.contextWindow ?? 0;
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const scrollToRef = useRef<HTMLDivElement>(null);

  // Show typing dots when pending (before server acks) or actively streaming
  const showTypingIndicator = isSendPending || isStreaming;
  const hasMessages = messages.length > 0 || showTypingIndicator;

  // ── "New messages" indicator state ──
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);

  // Track whether user is near the bottom (within 300px)
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const nearBottom = scrollHeight - scrollTop - clientHeight <= 300;
      isNearBottomRef.current = nearBottom;
      if (nearBottom) {
        setHasNewBelow(false);
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMessages]);

  // Detect new messages arriving while scrolled up
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && !isNearBottomRef.current) {
      setHasNewBelow(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // Clear indicator on session switch
  useEffect(() => {
    setHasNewBelow(false);
    isNearBottomRef.current = true;
  }, [activeSessionKey]);

  const scrollToBottom = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    setHasNewBelow(false);
  }, []);

  const handleSubmit = async () => {
    const hasText = inputValue.trim().length > 0;
    const hasAttachments = attachments.length > 0;
    if ((!hasText && !hasAttachments) || isStreaming) {
      return;
    }

    try {
      if (hasAttachments) {
        // Build structured content blocks for multimodal message
        const contentBlocks: Array<unknown> = [];
        if (hasText) {
          contentBlocks.push({ type: "text", text: inputValue });
        }
        for (const att of attachments) {
          const base64 = extractBase64(att.preview);
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: att.fileType,
              data: base64,
            },
          });
        }
        await sendMessage(contentBlocks);
      } else {
        await sendMessage(inputValue);
      }
      useChatStore.getState().clearDraft(activeSessionKey);
      setReplyTo(null);
    } catch {
      toast("Failed to send message", "error");
    }
  };

  // Wrapped delete with toast
  const handleDeleteSession = useCallback(
    async (key: string) => {
      try {
        await deleteSession(key);
        toast("Session deleted", "success");
      } catch {
        toast("Failed to delete session", "error");
      }
    },
    [deleteSession, toast],
  );

  const handleRenameSession = useCallback(
    async (key: string, newLabel: string) => {
      try {
        await sendRpc("sessions.patch", { key, label: newLabel });
        await loadSessions();
      } catch {
        toast("Failed to rename session", "error");
      }
    },
    [sendRpc, loadSessions, toast],
  );

  const handleNewChat = () => {
    const key = `web-${Date.now().toString(36)}`;
    switchSession(key);
  };

  // Compact session — trims old messages to free context
  const [isCompacting, setIsCompacting] = useState(false);
  const handleCompact = useCallback(async () => {
    if (!activeSessionKey || isCompacting) {
      console.warn("[compact] no active session or already compacting", {
        activeSessionKey,
        isCompacting,
      });
      return;
    }
    setIsCompacting(true);
    try {
      const res = await sendRpc<{ compacted?: boolean; reason?: string; kept?: number }>(
        "sessions.compact",
        { key: activeSessionKey, maxLines: 100 },
      );
      console.log("[compact] response:", res);
      if (res?.compacted) {
        toast("Session compacted", "success");
        await loadHistory();
      } else {
        const detail =
          res?.reason ?? (res?.kept ? `${res.kept} lines, under threshold` : undefined);
        toast(detail ? `Nothing to compact (${detail})` : "Nothing to compact", "success");
      }
    } catch (err) {
      console.error("[compact] error:", err);
      toast(`Failed to compact: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setIsCompacting(false);
    }
  }, [activeSessionKey, isCompacting, sendRpc, toast, loadHistory]);

  // Shell header portal target
  const headerPortal =
    typeof document !== "undefined" ? document.getElementById("shell-header-extra") : null;

  const sessionTitle = activeSession ? formatSessionTitle(activeSession) : "New Chat";
  const sessionKind = (activeSession?.kind as string | undefined) ?? null;
  const sessionChannel = (activeSession?.channel as string | undefined) ?? null;
  // Gateway returns flat token fields (inputTokens, outputTokens, totalTokens)
  const inputTokens =
    (activeSession?.inputTokens as number | undefined) ??
    activeSession?.tokenCounts?.totalInput ??
    0;
  const outputTokens =
    (activeSession?.outputTokens as number | undefined) ??
    activeSession?.tokenCounts?.totalOutput ??
    0;

  return (
    <>
      {/* Session details injected into Shell header via portal */}
      {headerPortal &&
        createPortal(
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground min-w-0">
            {/* Session title */}
            <span
              className="truncate max-w-[180px] sm:max-w-[260px] text-foreground/80 font-medium"
              title={sessionTitle}
            >
              {sessionTitle}
            </span>

            {/* Session kind / channel chip */}
            {(sessionKind || sessionChannel) && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span className="flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-muted/50 border border-border/40">
                  {sessionChannel ? (
                    <>
                      <Zap className="h-2.5 w-2.5" />
                      {sessionChannel}
                    </>
                  ) : (
                    sessionKind
                  )}
                </span>
              </>
            )}

            {/* Model chip — clickable to open model selector */}
            {activeSession?.model && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <button
                  ref={modelSelectorRef}
                  onClick={() => setModelSelectorOpen((prev) => !prev)}
                  className="hidden sm:flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-primary/5 border border-primary/10 text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors cursor-pointer"
                >
                  <Bot className="h-2.5 w-2.5" />
                  <span className="truncate max-w-[120px]">
                    {displayModel?.name ?? activeSession.model.split("/").pop()}
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-2 w-2 shrink-0 opacity-50 transition-transform",
                      modelSelectorOpen && "rotate-180",
                    )}
                  />
                </button>
              </>
            )}

            {/* Token usage */}
            {(inputTokens > 0 || outputTokens > 0) && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <span
                  className="shrink-0 tabular-nums"
                  title={`Input: ${inputTokens.toLocaleString()} / Output: ${outputTokens.toLocaleString()}`}
                >
                  {formatTokenCount(inputTokens + outputTokens)}
                  {contextTotal > 0 && (
                    <span className="text-muted-foreground/50">
                      {" / "}
                      {formatContextWindow(contextTotal)}
                    </span>
                  )}
                </span>
                {/* Mini context bar */}
                {contextTotal > 0 && tokenUsed > 0 && (
                  <div className="hidden sm:block w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden shrink-0">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        tokenUsed / contextTotal > 0.95
                          ? "bg-destructive"
                          : tokenUsed / contextTotal > 0.8
                            ? "bg-chart-5"
                            : "bg-primary/60",
                      )}
                      style={{ width: `${Math.min((tokenUsed / contextTotal) * 100, 100)}%` }}
                    />
                  </div>
                )}
              </>
            )}

            {/* Compact button */}
            {tokenUsed > 0 && (
              <>
                <Separator orientation="vertical" className="h-3.5" />
                <button
                  onClick={handleCompact}
                  disabled={isCompacting}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0",
                    isCompacting
                      ? "opacity-50 cursor-wait"
                      : "hover:bg-primary/15 hover:text-primary cursor-pointer",
                  )}
                  title="Compact session — trim old messages to free context"
                >
                  <Minimize2 className={cn("h-3 w-3", isCompacting && "animate-spin")} />
                  <span className="hidden sm:inline">Compact</span>
                </button>
              </>
            )}
          </div>,
          headerPortal,
        )}

      {/* Model selector dropdown — portalled to body to escape header overflow clipping */}
      {modelSelectorOpen &&
        createPortal(
          <div
            ref={modelDropdownRef}
            className="fixed z-[9999]"
            style={(() => {
              const rect = modelSelectorRef.current?.getBoundingClientRect();
              if (!rect) {
                return { top: 0, left: 0 };
              }
              return { top: rect.bottom + 4, left: rect.left };
            })()}
          >
            <div className="w-72 sm:w-80 rounded-xl border border-border bg-popover shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 origin-top">
              <div className="max-h-80 overflow-y-auto">
                {filteredModels.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    No models available
                  </div>
                ) : (
                  Object.entries(groupModelsByProvider(filteredModels)).map(
                    ([provider, providerModels]) => (
                      <div key={provider}>
                        <div className="sticky top-0 bg-popover px-3 py-1.5 border-b border-border/50">
                          <span
                            className={cn(
                              "text-[10px] font-mono uppercase tracking-wider",
                              providerColor(provider),
                            )}
                          >
                            {provider}
                          </span>
                        </div>
                        {providerModels.map((model) => {
                          const isSelected = model.id === activeSession?.model;
                          const isAllowed = model.allowed !== false;
                          return (
                            <button
                              key={model.id}
                              onClick={() => handleModelSwitch(model.id, model.provider)}
                              className={cn(
                                "flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-secondary/40 transition-colors",
                                isSelected && "bg-primary/5",
                                !isAllowed && "opacity-50",
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-mono truncate">{model.name}</span>
                                  {model.reasoning && (
                                    <span title="Reasoning">
                                      <Brain className="h-3 w-3 text-chart-5 shrink-0" />
                                    </span>
                                  )}
                                  {model.input?.includes("image") && (
                                    <span title="Vision">
                                      <Image className="h-3 w-3 text-chart-2 shrink-0" />
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] font-mono text-muted-foreground truncate">
                                    {model.id}
                                  </span>
                                  {model.contextWindow && (
                                    <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                                      {formatContextWindow(model.contextWindow)} ctx
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isSelected && (
                                <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ),
                  )
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div className="flex h-full bg-background overflow-hidden">
        {/* Desktop Sidebar */}
        <div
          className={cn(
            "hidden md:block border-r border-border h-full shrink-0 transition-all duration-200 ease-in-out overflow-hidden",
            chatSidebarCollapsed ? "w-[52px]" : "w-80",
          )}
        >
          <SessionSidebarContent
            onSelect={switchSession}
            activeKey={activeSessionKey}
            onNewChat={handleNewChat}
            onReset={resetSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            collapsed={chatSidebarCollapsed}
            onCollapse={setChatSidebarCollapsed}
          />
        </div>

        {/* Main chat area */}
        <div className="flex flex-1 flex-col min-w-0 h-full relative">
          {/* Header - Mobile Sidebar Trigger Only */}
          <div className="md:hidden flex items-center border-b border-border px-4 py-2 h-14 shrink-0 bg-background/80 backdrop-blur z-20 absolute top-0 left-0 right-0">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-2"
                  aria-label="Open chat sidebar"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 w-80 border-r border-border">
                <SessionSidebarContent
                  onSelect={switchSession}
                  activeKey={activeSessionKey}
                  onNewChat={handleNewChat}
                  onReset={resetSession}
                  onDelete={handleDeleteSession}
                  onRename={handleRenameSession}
                />
              </SheetContent>
            </Sheet>
            <span className="font-medium ml-2">Chat</span>
          </div>

          {/* Content area */}
          <div className="flex flex-1 flex-col min-h-0 pt-14 md:pt-0">
            {messagesLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <TextShimmerLoader text="Loading messages..." size="md" />
              </div>
            ) : !hasMessages ? (
              <div className="flex flex-1 items-center justify-center p-4">
                <EmptyState onSuggestionClick={setInputValue} />
              </div>
            ) : (
              <ChatContainer
                ref={chatContainerRef}
                scrollToRef={scrollToRef}
                className="flex-1 w-full relative"
              >
                <div
                  className="mx-auto w-full max-w-4xl py-6 md:py-10"
                  role="log"
                  aria-live="polite"
                >
                  {messages.map((msg, i) => {
                    // Skip tool messages that have been merged into preceding tool call cards
                    if (consumedIndices.has(i)) {
                      return null;
                    }
                    return (
                      <ChatMessageBubble
                        key={msg.id}
                        msg={msg}
                        index={i}
                        rating={ratings[i] ?? null}
                        isLastAssistant={i === lastAssistantIndex}
                        isGroupFirst={isFirstInGroup(messages, i)}
                        toolDisplayMode={toolDisplayMode}
                        mergedToolResults={mergedResults.get(i)}
                        onRate={handleRate}
                        onRegenerate={handleRegenerate}
                        onViewToolOutput={handleViewToolOutput}
                        onReply={handleReply}
                        onCopyId={handleCopyId}
                      />
                    );
                  })}
                  {showTypingIndicator && (
                    <StreamingBubble
                      content={isStreaming ? streamContent : ""}
                      isGroupFirst={
                        messages.length === 0 ||
                        (messages[messages.length - 1].role !== "assistant" &&
                          messages[messages.length - 1].role !== "tool")
                      }
                      paused={isPaused}
                    />
                  )}
                  <div ref={scrollToRef} className="h-4" />
                </div>
              </ChatContainer>
            )}

            {/* Scroll-to-bottom FAB + New messages indicator */}
            {hasMessages && (
              <div className="absolute bottom-24 right-6 md:right-10 z-20 flex flex-col items-center gap-2">
                {hasNewBelow && (
                  <button
                    onClick={scrollToBottom}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all animate-slide-in-up"
                  >
                    New messages
                    <ArrowDown className="h-3 w-3" />
                  </button>
                )}
                <PromptScrollButton
                  scrollRef={scrollToRef}
                  containerRef={chatContainerRef}
                  threshold={200}
                />
              </div>
            )}
          </div>

          {/* Improved Input Area */}
          <div className="shrink-0 p-4 pt-2 pb-6 z-20 bg-gradient-to-t from-background via-background to-transparent">
            <div className="mx-auto max-w-4xl relative">
              {/* Session status bar */}
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 flex items-center gap-2 text-[10px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-300">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    isConnected ? "bg-primary animate-glow-pulse" : "bg-destructive",
                  )}
                />
                <span>{isConnected ? "Connected" : "Disconnected"}</span>
              </div>

              {/* Hidden file input for Paperclip button */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />

              {/* ─── Queue Panel ─── */}
              {messageQueue.length > 0 && (
                <div className="mb-2 rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/30">
                    <span className="text-[11px] font-mono text-muted-foreground">
                      Queue ({messageQueue.length})
                    </span>
                    <div className="flex items-center gap-1">
                      {isQueueRunning ? (
                        <button
                          onClick={stopQueue}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors font-medium"
                        >
                          Stop
                        </button>
                      ) : (
                        <button
                          onClick={startQueue}
                          disabled={!isConnected}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors font-medium disabled:opacity-40"
                        >
                          Run All
                        </button>
                      )}
                      <button
                        onClick={() => useChatStore.getState().clearQueue()}
                        className="text-[10px] px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="max-h-32 overflow-y-auto">
                    {messageQueue.map((item, i) => (
                      <div
                        key={item.id}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 text-xs group",
                          item.status === "sending" && "bg-primary/5",
                          i < messageQueue.length - 1 && "border-b border-border/20",
                        )}
                      >
                        <span className="text-[10px] font-mono text-muted-foreground/60 w-4 shrink-0 text-center">
                          {item.status === "sending" ? (
                            <RefreshCw className="h-3 w-3 animate-spin text-primary" />
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span className="flex-1 truncate text-foreground/80">
                          {typeof item.content === "string" ? item.content : "[multimodal]"}
                        </span>
                        {/* Move up */}
                        {i > 0 && item.status !== "sending" && (
                          <button
                            onClick={() => useChatStore.getState().reorderQueue(i, i - 1)}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5"
                            title="Move up"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </button>
                        )}
                        {/* Move down */}
                        {i < messageQueue.length - 1 && item.status !== "sending" && (
                          <button
                            onClick={() => useChatStore.getState().reorderQueue(i, i + 1)}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5"
                            title="Move down"
                          >
                            <ArrowDown className="h-3 w-3" />
                          </button>
                        )}
                        {/* Remove */}
                        {item.status !== "sending" && (
                          <button
                            onClick={() => useChatStore.getState().removeFromQueue(item.id)}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 text-destructive"
                            title="Remove"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <PromptInput
                value={inputValue}
                onValueChange={setInputValue}
                onSubmit={handleSubmit}
                isLoading={isStreaming}
                className="bg-secondary/40 border-border/60 shadow-lg backdrop-blur-md rounded-3xl ring-1 ring-border/40 focus-within:ring-primary/20 transition-all p-0"
              >
                {/* Reply-to preview chip */}
                {replyTo && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1">
                    <div className="flex items-center gap-2 bg-muted/50 border border-border/50 rounded-lg px-3 py-1.5 text-xs font-mono text-muted-foreground max-w-full min-w-0">
                      <Reply className="h-3 w-3 shrink-0 text-primary" />
                      <span className="shrink-0 text-primary font-medium">#{replyTo.seq}</span>
                      <span className="truncate">{replyTo.preview}</span>
                      <button
                        onClick={clearReply}
                        className="shrink-0 ml-1 hover:text-foreground transition-colors"
                        aria-label="Dismiss reply"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Attachment previews */}
                {attachments.length > 0 && (
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1 overflow-x-auto">
                    {attachments.map((att) => (
                      <div key={att.id} className="relative shrink-0 group/att">
                        <img
                          src={att.preview}
                          alt={att.fileName}
                          className="h-12 w-12 rounded-lg object-cover border border-border/60"
                        />
                        <button
                          onClick={() => removeAttachment(att.id)}
                          className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center opacity-0 group-hover/att:opacity-100 transition-opacity shadow-sm hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
                          aria-label="Remove attachment"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {interimTranscript && sttState === "listening" && (
                  <div className="px-4 pb-1">
                    <div className="text-xs text-muted-foreground/70 italic font-mono truncate">
                      {interimTranscript}
                    </div>
                  </div>
                )}

                <div onPaste={handlePaste} className="relative">
                  <PromptInputTextarea
                    disabled={!isConnected}
                    className="text-base min-h-[56px] px-4 py-4 md:text-sm"
                  />
                  {/* Animated placeholder overlay */}
                  {!inputValue && (
                    <div
                      className="absolute inset-0 pointer-events-none flex items-start px-4 py-4"
                      aria-hidden
                    >
                      <AnimatedPlaceholder text={placeholder} isStreaming={isStreaming} />
                    </div>
                  )}
                </div>

                {/* Internal Toolbar */}
                <div className="flex items-center justify-between px-3 pb-3 pt-1">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="h-8 w-8 text-muted-foreground hover:bg-muted/50 rounded-lg hover:text-foreground"
                      onClick={() => fileInputRef.current?.click()}
                      title="Attach image"
                      aria-label="Attach image"
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    {/* Tool display mode toggle — left side near paperclip */}
                    <button
                      onClick={() =>
                        setToolDisplayMode((prev) =>
                          prev === "collapsed"
                            ? "expanded"
                            : prev === "expanded"
                              ? "hidden"
                              : "collapsed",
                        )
                      }
                      className={cn(
                        "flex items-center gap-1 px-2 h-8 text-xs font-mono rounded-lg hover:bg-muted/50 transition-colors cursor-pointer",
                        toolDisplayMode === "hidden"
                          ? "text-muted-foreground/40"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      title={`Tool display: ${toolDisplayMode}`}
                    >
                      {toolDisplayMode === "hidden" ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Wrench className="h-3.5 w-3.5" />
                      )}
                      <span className="hidden sm:inline">
                        {toolDisplayMode === "collapsed"
                          ? "Tools"
                          : toolDisplayMode === "expanded"
                            ? "Expanded"
                            : "Hidden"}
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        "h-8 w-8 rounded-full transition-all",
                        sttState === "listening"
                          ? "text-red-500 bg-red-500/10 hover:bg-red-500/20 animate-pulse"
                          : sttState === "processing"
                            ? "text-yellow-500 bg-yellow-500/10 cursor-wait"
                            : sttMode === "none"
                              ? "text-muted-foreground/40 cursor-not-allowed"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                      onClick={toggleStt}
                      disabled={sttMode === "none" || sttState === "processing"}
                      aria-label={
                        sttState === "listening"
                          ? "Stop listening"
                          : sttState === "processing"
                            ? "Transcribing..."
                            : "Voice input"
                      }
                      title={
                        sttMode === "none"
                          ? "Speech recognition not available"
                          : sttState === "listening" || sttState === "processing"
                            ? "Click to stop"
                            : `Voice input (${sttMode === "server" ? "server STT" : "browser"})`
                      }
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                    <button
                      onClick={cycleTtsMode}
                      className={cn(
                        "flex items-center gap-1 px-2 h-8 text-xs font-mono rounded-full transition-colors cursor-pointer",
                        ttsMode === "off"
                          ? "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          : "text-primary hover:bg-primary/10",
                      )}
                      title={`TTS: ${ttsMode}`}
                      aria-label={`Text-to-speech: ${ttsMode}`}
                    >
                      {ttsMode === "off" ? (
                        <VolumeOff className="h-4 w-4" />
                      ) : (
                        <Volume2 className="h-4 w-4" />
                      )}
                      {ttsMode !== "off" && (
                        <span className="hidden sm:inline text-[10px]">{ttsMode}</span>
                      )}
                    </button>
                    <PromptInputActions>
                      <div className="flex items-center gap-1">
                        {/* Queue button — always visible; enqueues current input or shows queue count */}
                        <button
                          onClick={() => {
                            const content = inputValue.trim();
                            if (!content) {
                              return;
                            }
                            useChatStore.getState().enqueueMessage(content);
                            setInputValue("");
                          }}
                          disabled={!inputValue.trim() && attachments.length === 0}
                          aria-label={
                            messageQueue.length > 0
                              ? `Queue (${messageQueue.length})`
                              : "Add to queue"
                          }
                          title={
                            messageQueue.length > 0
                              ? `${messageQueue.length} in queue`
                              : "Add to queue"
                          }
                          className={cn(
                            "relative h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all duration-200",
                            inputValue.trim()
                              ? "bg-sky-600 text-white transform hover:scale-105 hover:bg-sky-500"
                              : "bg-sky-600/15 text-sky-400/30 border border-sky-600/20",
                          )}
                        >
                          <ListPlus className="h-4 w-4" />
                          {messageQueue.length > 0 && (
                            <span className="absolute -top-1 -right-1 h-4 min-w-4 px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center shadow-sm">
                              {messageQueue.length}
                            </span>
                          )}
                        </button>

                        {/* Streaming controls: pause/resume + stop */}
                        {isStreaming && (
                          <>
                            <button
                              onClick={() => {
                                const store = useChatStore.getState();
                                if (store.isPaused) {
                                  store.resumeStream();
                                } else {
                                  store.pauseStream();
                                }
                              }}
                              aria-label={isPaused ? "Resume output" : "Pause output"}
                              title={isPaused ? "Resume output" : "Pause output"}
                              className={cn(
                                "h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all transform hover:scale-105",
                                isPaused
                                  ? "bg-amber-500 text-white hover:bg-amber-400"
                                  : "bg-amber-500/80 text-white hover:bg-amber-500",
                              )}
                            >
                              {isPaused ? (
                                <Play className="h-3.5 w-3.5 fill-current" />
                              ) : (
                                <Pause className="h-3.5 w-3.5 fill-current" />
                              )}
                            </button>
                            <button
                              onClick={abortRun}
                              aria-label="Stop generating"
                              title="Stop generating"
                              className="h-8 w-8 rounded-full flex items-center justify-center bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-md transform hover:scale-105 transition-all"
                            >
                              <Square className="h-3.5 w-3.5 fill-current" />
                            </button>
                          </>
                        )}

                        {/* Send button — always visible when not streaming */}
                        {!isStreaming && (
                          <button
                            onClick={handleSubmit}
                            disabled={
                              (!inputValue.trim() && attachments.length === 0) || !isConnected
                            }
                            aria-label="Send message"
                            title="Send message"
                            className={cn(
                              "h-8 w-8 rounded-full flex items-center justify-center shadow-md transition-all duration-200",
                              inputValue.trim() || attachments.length > 0
                                ? "bg-primary text-primary-foreground transform hover:scale-105"
                                : "bg-primary/15 text-primary/30 border border-primary/20",
                            )}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </PromptInputActions>
                  </div>
                </div>
              </PromptInput>

              {/* Model dropdown is now in the session header */}

              <div className="text-center mt-2 text-[10px] text-muted-foreground/40 font-mono">
                AI Operator can make mistakes. Please verify important information.
              </div>
            </div>
          </div>
        </div>

        {/* Tool output viewer panel */}
        <Sheet
          open={toolOutputPanel.open}
          onOpenChange={(open) => setToolOutputPanel((prev) => ({ ...prev, open }))}
        >
          <SheetContent side="right" className="w-full sm:max-w-lg md:max-w-xl p-0 flex flex-col">
            <SheetHeader className="border-b border-border px-4 py-3 shrink-0">
              <SheetTitle className="text-sm font-mono flex items-center gap-2">
                <Wrench className="h-4 w-4 text-muted-foreground" />
                {toolOutputPanel.name}
              </SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto p-4">
              <pre className="text-xs font-mono text-foreground/90 whitespace-pre-wrap break-all leading-relaxed">
                {toolOutputPanel.content}
              </pre>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
