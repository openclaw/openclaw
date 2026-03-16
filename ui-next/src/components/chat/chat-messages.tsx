import {
  Bot,
  Copy,
  Check,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FileText,
  Code2,
  BookOpen,
  ThumbsUp,
  ThumbsDown,
  Brain,
  Reply,
  Hash,
  User,
  Pause,
  History,
  Sparkles,
  Zap,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { PlanCard, extractPlanSteps } from "@/components/chat/plan-card";
import { isCompactionMessage, CompactionDivider } from "@/components/chat/system-events";
import {
  ToolCallCard,
  extractToolCards,
  UsageBadge,
  formatTokens,
  type ToolDisplayMode,
} from "@/components/chat/tool-call-card";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/custom/prompt/markdown";
import { useSuggestions, type Suggestion } from "@/hooks/use-suggestions";
import { cn } from "@/lib/utils";
import { getMessageText, getMessageImages, type ChatMessage } from "@/store/chat-store";

// ─── Time formatting ───

function formatTime(ts: number): string {
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}/${month} ${time}`;
}

// ─── Elapsed timer hook ───

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function useElapsedTimer() {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return elapsed;
}

// ─── Loop detection ───

/**
 * Detect when streaming text is stuck in a repetitive reasoning loop.
 * Splits the text into sentences, finds repeated phrases (3+ occurrences),
 * and flags it as a likely loop.
 */
function useLoopDetection(content: string, minChars = 500): boolean {
  return useMemo(() => {
    if (content.length < minChars) {
      return false;
    }
    // Split into sentence-like chunks and look for repeating patterns
    const sentences = content
      .split(/[.!?]\s+/)
      .map((s) => s.trim().toLowerCase().slice(0, 80))
      .filter((s) => s.length > 20);
    if (sentences.length < 6) {
      return false;
    }
    // Count occurrences of each sentence
    const counts = new Map<string, number>();
    for (const s of sentences) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    // If any sentence appears 3+ times, it's likely a loop
    for (const count of counts.values()) {
      if (count >= 3) {
        return true;
      }
    }
    return false;
  }, [content, minChars]);
}

// ─── Clipboard hook ───

function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

// ─── Message Grouping ───

/**
 * Determine whether a message is the first in a consecutive group of the same
 * effective role. Tool messages are treated as "assistant" for grouping purposes.
 */
export function isFirstInGroup(messages: ChatMessage[], index: number): boolean {
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

function extractThinking(msg: ChatMessage): { thinking: string | null; content: string } {
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

  const text = getMessageText(msg);
  const matches: string[] = [];
  let match: RegExpExecArray | null;
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

// ─── Thinking Section ───

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

// ─── Agent Avatar ───

/** Derive a subtle border color class from an agent name for visual distinction. */
function agentBorderColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  const colors = [
    "border-chart-1/40",
    "border-chart-2/40",
    "border-chart-3/40",
    "border-chart-4/40",
    "border-chart-5/40",
    "border-primary/30",
  ];
  return colors[Math.abs(hash) % colors.length];
}

function AgentAvatar({
  emoji,
  name,
  className,
}: {
  emoji?: string;
  name?: string;
  className?: string;
}) {
  const borderColor = name ? agentBorderColor(name) : "border-primary/20";

  return (
    <div className={cn("flex flex-col items-center gap-0.5 shrink-0", className)}>
      <div
        className={cn(
          "w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center border shrink-0",
          borderColor,
          name && "ring-1 ring-primary/10",
        )}
      >
        {emoji ? (
          <span className="text-sm leading-none">{emoji}</span>
        ) : (
          <Bot className="h-4 w-4 text-primary" />
        )}
      </div>
      {name && (
        <span className="text-[9px] text-muted-foreground/70 font-medium truncate max-w-[4rem] leading-tight">
          {name}
        </span>
      )}
    </div>
  );
}

// ─── Visual Components ───

export function GlowingOrb() {
  return (
    <div className="relative flex h-32 w-32 items-center justify-center">
      <div className="absolute inset-0 rounded-full bg-gradient-to-t from-primary/30 to-chart-2/30 blur-2xl animate-pulse" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-gray-900 to-black shadow-2xl border border-white/10 flex items-center justify-center overflow-hidden ring-1 ring-white/10">
        <div className="absolute inset-0 bg-gradient-to-tr from-primary/30 via-transparent to-chart-2/30 opacity-60" />
        <div className="absolute -top-4 -left-4 h-12 w-12 rounded-full bg-primary/30 blur-xl" />
        <Bot className="h-8 w-8 text-primary relative z-10" />
      </div>
    </div>
  );
}

// ─── Empty State ───

const SUGGESTION_ICONS: Record<Suggestion["icon"], React.ComponentType<{ className?: string }>> = {
  history: History,
  agent: Bot,
  skill: Zap,
  memory: Brain,
  generic: Sparkles,
};

/** Fallback icons for generic suggestions by label keyword. */
function genericIcon(label: string): React.ComponentType<{ className?: string }> {
  const lower = label.toLowerCase();
  if (lower.includes("summary")) {
    return FileText;
  }
  if (lower.includes("code")) {
    return Code2;
  }
  if (lower.includes("research")) {
    return BookOpen;
  }
  return Sparkles;
}

export function EmptyState({ onSuggestionClick }: { onSuggestionClick: (text: string) => void }) {
  const { suggestions, loading } = useSuggestions();

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
        {loading ? (
          // Skeleton placeholders while loading
          <>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-4 py-2.5 rounded-full border border-border/40 bg-card/20 animate-pulse"
              >
                <div className="h-3.5 w-3.5 rounded-full bg-primary/10" />
                <div className="h-3 w-16 rounded bg-foreground/5" />
              </div>
            ))}
          </>
        ) : (
          suggestions.map((s) => {
            const IconComponent =
              s.icon === "generic" ? genericIcon(s.label) : SUGGESTION_ICONS[s.icon];
            return (
              <button
                key={s.label}
                onClick={() => onSuggestionClick(s.action)}
                className="group/suggestion flex items-center gap-2.5 px-4 py-2.5 rounded-full border border-border bg-card/30 hover:bg-card/80 hover:border-primary/30 hover:shadow-sm hover:shadow-primary/5 transition-all duration-200 text-sm md:text-xs"
                title={s.description}
              >
                <IconComponent className="h-3.5 w-3.5 text-primary shrink-0 transition-transform duration-200 group-hover/suggestion:scale-110" />
                <span className="text-foreground/80 truncate max-w-[200px]">{s.label}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Animated Placeholder ───

export function AnimatedPlaceholder({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [displayed, setDisplayed] = useState(text);
  const [fadeState, setFadeState] = useState<"in" | "out">("in");
  const prevTextRef = useRef(text);

  useEffect(() => {
    if (text === prevTextRef.current) {
      return;
    }
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

const STREAM_BUBBLE_MIN_CHARS = 20;

export function StreamingBubble({
  content,
  isGroupFirst = true,
  paused = false,
  agentEmoji,
  agentName,
  stepCount = 0,
  runTokens = 0,
  activityLabel = "",
  onAbort,
  showPlanCard = true,
}: {
  content: string;
  isGroupFirst?: boolean;
  paused?: boolean;
  agentEmoji?: string;
  agentName?: string;
  stepCount?: number;
  runTokens?: number;
  activityLabel?: string;
  onAbort?: () => void;
  /** Suppress plan card when a finalized message already shows one. */
  showPlanCard?: boolean;
}) {
  const hasEnoughContent = content.length >= STREAM_BUBBLE_MIN_CHARS;
  const elapsed = useElapsedTimer();
  const isLooping = useLoopDetection(content);

  const avatarNode = <AgentAvatar emoji={agentEmoji} name={agentName} className="mt-1" />;

  const statusLabel = (
    <span className="text-[10px] text-muted-foreground/60 font-mono tabular-nums ml-1.5">
      {stepCount > 0 && <span className="text-primary/50">Step {stepCount} · </span>}
      {formatElapsed(elapsed)}
      {runTokens > 0 && (
        <span className="text-chart-5/50 ml-1.5">· {formatTokens(runTokens)} tok</span>
      )}
      {activityLabel && (
        <span
          className={cn(
            "ml-1.5 max-w-[200px] truncate inline-block align-bottom",
            activityLabel.endsWith(" failed") ? "text-destructive/60" : "text-muted-foreground/40",
          )}
        >
          · {activityLabel}
        </span>
      )}
    </span>
  );

  if (!hasEnoughContent) {
    return (
      <div className="flex gap-3 px-4 py-2 animate-fade-in">
        {avatarNode}
        <div className="flex items-center gap-1.5 px-4 py-3">
          <div className="h-1.5 w-1.5 bg-primary/50 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
          <div className="h-1.5 w-1.5 bg-primary/50 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
          <div className="h-1.5 w-1.5 bg-primary/50 rounded-full animate-bounce"></div>
          {statusLabel}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("animate-slide-in-left flex gap-3 px-4", isGroupFirst ? "py-2" : "py-1")}>
      {isGroupFirst ? avatarNode : <div className="w-8 shrink-0" />}
      <div className="max-w-[90%] md:max-w-[85%]">
        <div
          className={cn(
            "bg-card/40 text-foreground border border-border/60 rounded-2xl rounded-bl-sm px-6 py-5 shadow-sm backdrop-blur-md",
            paused && "border-chart-5/40",
          )}
        >
          {(() => {
            const { steps: planSteps, rest: planRest } = extractPlanSteps(content);
            const hasPlan = showPlanCard && planSteps.length >= 2;
            return (
              <>
                {hasPlan && <PlanCard steps={planSteps} className="mb-3" />}
                {(hasPlan ? planRest : content) && (
                  <div className="prose prose-sm prose-chat max-w-none break-words leading-relaxed font-sans">
                    <Markdown>{hasPlan ? planRest : content}</Markdown>
                  </div>
                )}
              </>
            );
          })()}
          {paused && (
            <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-border/40 text-[10px] text-chart-5/80 font-mono">
              <Pause className="h-2.5 w-2.5" />
              Paused
            </div>
          )}
          {isLooping && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-destructive/30">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive/80 shrink-0" />
              <span className="text-xs text-destructive/80">Agent appears stuck in a loop</span>
              {onAbort && (
                <button
                  onClick={onAbort}
                  className="ml-auto px-2.5 py-1 rounded-md bg-destructive/10 text-destructive text-xs font-medium hover:bg-destructive/20 transition-colors"
                >
                  Stop
                </button>
              )}
            </div>
          )}
        </div>
        <div className="mt-1 ml-1">{statusLabel}</div>
      </div>
    </div>
  );
}

// ─── Message Bubble ───

export function ChatMessageBubble({
  msg,
  index,
  rating,
  isLastAssistant,
  isGroupFirst = true,
  toolDisplayMode = "collapsed",
  mergedToolResults,
  agentEmoji,
  agentName,
  prevTotalTokens,
  inputTokens,
  onRate,
  onRegenerate,
  onViewToolOutput,
  onReply,
  onCopyId,
  onDelete,
  showPlanCard = true,
  sessionComplete = false,
  agentId,
}: {
  msg: ChatMessage;
  index: number;
  rating?: "up" | "down" | null;
  isLastAssistant: boolean;
  isGroupFirst?: boolean;
  toolDisplayMode?: ToolDisplayMode;
  mergedToolResults?: string[];
  agentEmoji?: string;
  agentName?: string;
  /** Previous assistant message's total tokens (for computing delta). */
  prevTotalTokens?: number;
  /** Input tokens consumed by the LLM for the turn following this user message. */
  inputTokens?: number;
  onRate: (index: number, rating: "up" | "down") => void;
  onRegenerate: () => void;
  onViewToolOutput?: (name: string, content: string) => void;
  onReply?: (msg: ChatMessage) => void;
  onCopyId?: (msg: ChatMessage) => void;
  onDelete?: (msg: ChatMessage) => void;
  /** Only render the PlanCard on this message (avoids duplicate cards across intermediate messages). */
  showPlanCard?: boolean;
  /** Session is complete (not streaming) — auto-complete remaining plan steps. */
  sessionComplete?: boolean;
  /** Agent ID for workspace file URL construction (inline image previews). */
  agentId?: string;
}) {
  const text = getMessageText(msg);
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const isTool = msg.role === "tool" || (msg.role as string) === "toolResult";
  const { copied, copy } = useCopyToClipboard();
  const { copied: idCopied, copy: copyId } = useCopyToClipboard();

  // Compute token delta from previous assistant message
  const currentTotal = msg.usage?.totalTokens ?? (msg.usage?.input ?? 0) + (msg.usage?.output ?? 0);
  const tokenDelta =
    currentTotal > 0 && prevTotalTokens != null ? currentTotal - prevTotalTokens : undefined;

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
    // Render compaction markers as inline dividers
    if (isCompactionMessage(msg)) {
      return <CompactionDivider />;
    }
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
          {/* Input token badge — shows how many tokens the LLM processed for this turn */}
          {inputTokens != null && inputTokens > 0 && (
            <div className="flex justify-end mb-0.5 mr-1">
              <span
                className="flex items-center gap-1 text-[10px] text-chart-5/60 font-mono tabular-nums"
                title={`Input tokens: ${inputTokens.toLocaleString()} (total prompt size for this turn)`}
              >
                <Zap className="h-2.5 w-2.5" />
                {formatTokens(inputTokens)}
              </span>
            </div>
          )}
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-5 py-3.5 shadow-lg shadow-primary/10 ring-1 ring-white/10">
            <p className="text-sm whitespace-pre-wrap leading-relaxed font-sans">{text}</p>
            <MessageImages msg={msg} />
          </div>
          {/* User message actions */}
          <div className="flex items-center justify-end gap-1 mt-1 mr-1">
            {msg.timestamp && (
              <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
                {formatTime(msg.timestamp)}
              </span>
            )}
            <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
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
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="h-6 w-6 text-destructive/60 hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                  onClick={() => onDelete(msg)}
                  title="Delete message"
                  aria-label="Delete message"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </span>
          </div>
        </div>
        {isGroupFirst ? (
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center ml-2 border border-primary/10 shrink-0">
            <User className="h-4 w-4 text-primary" />
          </div>
        ) : (
          <div className="w-8 ml-2 shrink-0" />
        )}
      </div>
    );
  }

  // Tool role messages
  if (isTool) {
    if (toolDisplayMode === "hidden" || toolDisplayMode === "collapsed") {
      return null;
    }
    if (hasToolCards) {
      return (
        <div className="px-4 py-1 animate-fade-in ml-11">
          <ToolCallCard
            cards={toolCards}
            displayMode={toolDisplayMode}
            onViewOutput={onViewToolOutput}
            agentId={agentId}
          />
        </div>
      );
    }
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
          agentId={agentId}
        />
      </div>
    );
  }

  // Assistant message
  const { thinking, content: displayContent } = extractThinking(msg);
  const hasText = displayContent.trim().length > 0;
  const hasError = Boolean(msg.errorMessage && msg.stopReason === "error");
  const isNetworkError =
    /network.?error|econnreset|etimedout|socket hang up|fetch failed/i.test(text) ||
    /network.?error/i.test(msg.errorMessage ?? "");
  const toolsHidden = toolDisplayMode === "hidden";
  if (toolsHidden && hasToolCards && !hasText && !hasError && !thinking) {
    return null;
  }

  return (
    <div
      className={cn("group px-4 animate-slide-in-left flex gap-3", isGroupFirst ? "py-2" : "py-1")}
    >
      {isGroupFirst ? (
        <AgentAvatar emoji={agentEmoji} name={agentName} className="mt-1" />
      ) : (
        <div className="w-8 shrink-0" />
      )}
      <div className="max-w-[90%] md:max-w-[85%]">
        <div className="bg-card/40 text-foreground border border-border/60 rounded-2xl rounded-bl-sm px-6 py-5 shadow-sm backdrop-blur-md transition-colors group-hover:bg-card/60 group-hover:border-border/80">
          {thinking && <ThinkingSection thinking={thinking} />}

          {hasToolCards && (
            <div className={cn(hasText && "mb-3")}>
              <ToolCallCard
                cards={toolCards}
                displayMode={toolDisplayMode}
                onViewOutput={onViewToolOutput}
                agentId={agentId}
              />
            </div>
          )}

          {hasText &&
            (() => {
              const { steps: planSteps, rest: planRest } = extractPlanSteps(displayContent);
              const hasPlan = showPlanCard && planSteps.length >= 2;
              return (
                <>
                  {hasPlan && (
                    <PlanCard
                      steps={planSteps}
                      className="mb-3"
                      sessionComplete={sessionComplete}
                    />
                  )}
                  {(hasPlan ? planRest : displayContent) && (
                    <div className="prose prose-sm prose-chat max-w-none break-words leading-relaxed font-sans">
                      <Markdown agentId={agentId}>{hasPlan ? planRest : displayContent}</Markdown>
                    </div>
                  )}
                </>
              );
            })()}
          {hasError && !hasText && (
            <p className="text-sm text-destructive/80 font-mono">{msg.errorMessage}</p>
          )}
          {isNetworkError && isLastAssistant && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/30">
              <span className="text-xs text-muted-foreground">Connection lost</span>
              <button
                onClick={onRegenerate}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors"
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          )}
          <MessageImages msg={msg} />
        </div>

        {/* Actions Toolbar */}
        <div className="flex items-center gap-1 mt-2 ml-1">
          {/* Always-visible token badge */}
          {msg.usage && <UsageBadge usage={msg.usage} delta={tokenDelta} />}
          {/* Always-visible timestamp */}
          {msg.timestamp && (
            <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
              {formatTime(msg.timestamp)}
            </span>
          )}
          {/* Hover-only actions */}
          <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all duration-200 translate-y-1 group-hover:translate-y-0">
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
            {onDelete && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="h-7 w-7 text-destructive/60 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                onClick={() => onDelete(msg)}
                title="Delete message"
                aria-label="Delete message"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
