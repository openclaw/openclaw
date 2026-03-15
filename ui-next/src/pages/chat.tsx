import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import {
  ChatHeader,
  useAgentMap,
  useActiveAgentEmoji,
  useActiveAgentLabel,
  useActiveAgentName,
  useActiveAgentMeta,
} from "@/components/chat/chat-header";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatLayout } from "@/components/chat/chat-layout";
import {
  ChatMessageBubble,
  StreamingBubble,
  EmptyState,
  isFirstInGroup,
} from "@/components/chat/chat-messages";
import type { ContextPanelContent } from "@/components/chat/context-panel";
import { extractPlanSteps } from "@/components/chat/plan-card";
import { parseAgentSystemEvent, type AgentEventPayload } from "@/components/chat/system-events";
import { extractToolCards, type ToolDisplayMode } from "@/components/chat/tool-call-card";
import { Button } from "@/components/ui/button";
import { ChatContainer } from "@/components/ui/custom/prompt/chat-container";
import { TextShimmerLoader } from "@/components/ui/custom/prompt/loader";
import { PromptScrollButton } from "@/components/ui/custom/prompt/scroll-button";
import { type ModelEntry } from "@/components/ui/custom/status/model-selector";
import { useToast } from "@/components/ui/custom/toast";
import { useChat } from "@/hooks/use-chat";
import { useDynamicPlaceholder } from "@/hooks/use-dynamic-placeholder";
import { useGateway, onAgentPushEvent } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useChatStore, getMessageText, type ChatMessage } from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

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

  const messages = useChatStore((s) => s.getSessionState(s.activeSessionKey).messages);
  const messagesLoading = useChatStore(
    (s) => s.getSessionState(s.activeSessionKey).messagesLoading,
  );
  const isStreamingRaw = useChatStore((s) => s.getSessionState(s.activeSessionKey).isStreaming);
  const isAgentActive = useChatStore((s) => s.getSessionState(s.activeSessionKey).isAgentActive);
  // Treat background agent activity the same as streaming for UI indicators
  const isStreaming = isStreamingRaw || isAgentActive;
  const isPaused = useChatStore((s) => s.getSessionState(s.activeSessionKey).isPaused);
  const isSendPending = useChatStore((s) => s.getSessionState(s.activeSessionKey).isSendPending);
  const streamContent = useChatStore((s) => s.getSessionState(s.activeSessionKey).streamContent);
  const activityLabel = useChatStore((s) => s.getSessionState(s.activeSessionKey).activityLabel);
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // Agent identity
  const agentMap = useAgentMap();
  const activeAgentEmoji = useActiveAgentEmoji(agentMap);
  const activeAgentLabel = useActiveAgentLabel(agentMap);
  const activeAgentName = useActiveAgentName(agentMap);
  const { role: activeAgentRole, department: activeAgentDepartment } = useActiveAgentMeta(agentMap);
  const placeholder = useDynamicPlaceholder(activeAgentLabel);

  // Draft state from store
  const inputValue = useChatStore((s) => s.drafts[s.activeSessionKey]?.inputValue ?? "");
  const setInputValue = useCallback((valOrFn: string | ((prev: string) => string)) => {
    const store = useChatStore.getState();
    const key = store.activeSessionKey;
    const prev = store.drafts[key]?.inputValue ?? "";
    const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
    store.setDraftInput(key, next);
  }, []);

  // Models
  const [models, setModels] = useState<ModelEntry[]>([]);
  useEffect(() => {
    if (isConnected) {
      sendRpc<{ models?: ModelEntry[] }>("models.list", {})
        .then((result) => setModels(result?.models ?? []))
        .catch(() => toast("Failed to load models", "error"));
    }
  }, [isConnected, sendRpc, toast]);

  // Subscribe to agent events for system toasts (compaction, fallback)
  // Suppressed in focus mode to reduce distractions
  useEffect(() => {
    return onAgentPushEvent((payload) => {
      const evt = parseAgentSystemEvent(payload as AgentEventPayload);
      if (evt) {
        toast(evt.message, evt.variant);
      }
    });
  }, [toast]);

  // After a stream finalizes, refresh history from the server to pick up
  // full message data (usage, stopReason, etc.) that the live "final" event
  // doesn't include.
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (wasStreaming && !isStreaming) {
      // Small delay to let the server flush the transcript write
      const timer = setTimeout(() => {
        void loadHistory();
        void loadSessions(); // Refresh session token counts for context bar
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, loadHistory]);

  const [toolDisplayMode, setToolDisplayMode] = useState<ToolDisplayMode>("collapsed");

  // Context panel (tool output viewer, future: agent info, memory, skills)
  const [contextPanel, setContextPanel] = useState<{
    open: boolean;
    content: ContextPanelContent | null;
  }>({ open: false, content: null });

  const handleViewToolOutput = useCallback((name: string, content: string) => {
    setContextPanel({
      open: true,
      content: { mode: "tool-output", title: name, content },
    });
  }, []);

  const handleCloseContextPanel = useCallback(() => {
    setContextPanel((prev) => ({ ...prev, open: false }));
  }, []);

  // Reply handler passed to message bubbles
  const handleReply = useCallback(
    (msg: ChatMessage) => {
      const msgText = getMessageText(msg);
      const lines = msgText.split("\n").slice(0, 2);
      let preview = lines.join("\n");
      if (preview.length > 150) {
        preview = preview.slice(0, 150) + "\u2026";
      } else if (msgText.split("\n").length > 2) {
        preview += "\u2026";
      }
      const quoteBlock = `> [Re: #${msg.seq}] ${preview}\n\n`;
      setInputValue((prev) => {
        const stripped = prev.replace(/^> \[Re: #\d+\][\s\S]*?\n\n/, "");
        return quoteBlock + stripped;
      });
      setTimeout(() => document.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
    },
    [setInputValue],
  );

  const handleCopyId = useCallback((_msg: ChatMessage) => {
    // Copy handled in the bubble via useCopyToClipboard; hook for future use
  }, []);

  const handleDeleteMessage = useCallback(
    async (msg: ChatMessage) => {
      try {
        await sendRpc("chat.deleteMessages", {
          key: activeSessionKey,
          match: {
            role: msg.role,
            timestamp: msg.timestamp,
            contentPrefix: (typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((c) => (c as { text?: string }).text ?? "").join("")
                : ""
            ).slice(0, 200),
          },
        });
        // Remove from local store immediately (don't wait for poll)
        const store = useChatStore.getState();
        const current = store.getSessionState(activeSessionKey).messages;
        const filtered = current.filter((m) => m.id !== msg.id);
        if (filtered.length !== current.length) {
          store.setMessages(filtered, undefined, activeSessionKey);
        }
        toast("Message deleted", "success");
      } catch (err) {
        console.error("[chat] delete message failed:", err);
        toast("Failed to delete message", "error");
      }
    },
    [sendRpc, activeSessionKey, toast],
  );

  // Message ratings
  const [ratings, setRatings] = useState<Record<number, "up" | "down">>({});
  useEffect(() => {
    setRatings({});
  }, [activeSessionKey]);

  const lastAssistantIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return i;
      }
    }
    return -1;
  }, [messages]);

  // Only show PlanCard on the last message that contains one (avoids repeated cards)
  const lastPlanMessageIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") {
        continue;
      }
      const text =
        typeof messages[i].content === "string"
          ? (messages[i].content as string)
          : Array.isArray(messages[i].content)
            ? (messages[i].content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
            : "";
      if (extractPlanSteps(text).steps.length >= 2) {
        return i;
      }
    }
    return -1;
  }, [messages]);

  // Pre-process: merge tool result messages into preceding assistant tool calls
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
      const results: string[] = [];
      let j = i + 1;
      while (
        j < messages.length &&
        (messages[j].role === "tool" || (messages[j].role as string) === "toolResult")
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
      sendRpc("chat.feedback", {
        sessionKey: activeSessionKey,
        messageIndex,
        rating: isToggleOff ? null : value,
      }).catch(() => {});
    },
    [sendRpc, activeSessionKey, ratings],
  );

  const handleRegenerate = useCallback(() => {
    if (isStreaming) {
      return;
    }
    // Find the last user message
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return;
    }
    const lastUserText = getMessageText(messages[lastUserIndex]);
    if (!lastUserText.trim()) {
      return;
    }
    // Remove the last user message and everything after it (assistant response, tool results)
    useChatStore.getState().truncateMessagesFrom(lastUserIndex);
    // Re-send — sendMessage will optimistically append a fresh user message + get new response
    void sendMessage(lastUserText);
  }, [messages, isStreaming, sendMessage]);

  // Session actions
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

  const handleArchiveSidebar = useCallback(
    async (key: string, archive: boolean) => {
      try {
        await sendRpc("sessions.archive", { key, archived: archive });
        await loadSessions();
        if (archive && key === activeSessionKey) {
          const store = useChatStore.getState();
          const remaining = store.sessions;
          const fallback = remaining[0]?.key ?? "main";
          switchSession(fallback);
        }
        toast(archive ? "Session archived" : "Session unarchived", "success");
      } catch (err) {
        toast(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    [sendRpc, loadSessions, activeSessionKey, switchSession, toast],
  );

  // Scroll management
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const scrollToRef = useRef<HTMLDivElement>(null);
  const showTypingIndicator = isSendPending || isStreaming;

  // In-session search
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Ordered array of matching message indices
  const searchMatches = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) {
      return [];
    }

    // Jump to message by seq number: #10, #42, etc.
    const seqMatch = q.match(/^#(\d+)$/);
    if (seqMatch) {
      const seq = parseInt(seqMatch[1], 10);
      const idx = messages.findIndex((m) => m.seq === seq);
      return idx >= 0 ? [idx] : [];
    }

    const lower = q.toLowerCase();
    const matches: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const text =
        typeof messages[i].content === "string"
          ? (messages[i].content as string)
          : Array.isArray(messages[i].content)
            ? (messages[i].content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
            : "";
      if (text.toLowerCase().includes(lower)) {
        matches.push(i);
      }
    }
    return matches;
  }, [messages, searchQuery]);

  const searchMatchIndices = useMemo(() => new Set(searchMatches), [searchMatches]);

  // Reset current match when query changes; for #N jumps, trigger scroll immediately
  useEffect(() => {
    setSearchCurrentIdx(0);
  }, [searchQuery, searchMatches.length]);

  // Scroll to current match within the chat container
  useEffect(() => {
    if (searchMatches.length === 0) {
      return;
    }
    const msgIdx = searchMatches[searchCurrentIdx];
    if (msgIdx == null) {
      return;
    }
    const el = document.querySelector(`[data-msg-index="${msgIdx}"]`);
    if (!el) {
      return;
    }
    const container = chatContainerRef.current;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      // Calculate where to scroll so the element is centered in the container
      const elRelativeTop = elRect.top - containerRect.top + container.scrollTop;
      const centerOffset = elRelativeTop - container.clientHeight / 2 + elRect.height / 2;
      container.scrollTo({ top: centerOffset, behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [searchCurrentIdx, searchMatches]);

  const searchNext = useCallback(() => {
    setSearchCurrentIdx((prev) => (prev + 1) % Math.max(searchMatches.length, 1));
  }, [searchMatches.length]);

  const searchPrev = useCallback(() => {
    setSearchCurrentIdx(
      (prev) => (prev - 1 + searchMatches.length) % Math.max(searchMatches.length, 1),
    );
  }, [searchMatches.length]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => {
      if (!prev) {
        setTimeout(() => searchInputRef.current?.focus(), 0);
      } else {
        setSearchQuery("");
        setSearchCurrentIdx(0);
      }
      return !prev;
    });
  }, []);

  // Keyboard shortcut: Ctrl/Cmd+F to toggle search, Enter for next, Shift+Enter for prev
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        toggleSearch();
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
        setSearchCurrentIdx(0);
      }
      if (searchOpen && e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (e.shiftKey) {
          searchPrev();
        } else {
          searchNext();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen, toggleSearch, searchNext, searchPrev]);

  // Highlight matching search terms in the rendered DOM
  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) {
      return;
    }

    // Clear previous highlights
    container.querySelectorAll("mark.search-hl").forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
        parent.normalize();
      }
    });

    const q = searchQuery.trim();
    if (!q || q.startsWith("#")) {
      return;
    }
    const lower = q.toLowerCase();

    // Walk all text nodes and wrap matches
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const hits: { node: Text; start: number }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.textContent || "";
      let idx = text.toLowerCase().indexOf(lower);
      while (idx !== -1) {
        hits.push({ node, start: idx });
        idx = text.toLowerCase().indexOf(lower, idx + lower.length);
      }
    }

    // Apply in reverse so offsets don't shift
    for (let i = hits.length - 1; i >= 0; i--) {
      const { node, start } = hits[i];
      try {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + q.length);
        const mark = document.createElement("mark");
        mark.className = "search-hl";
        range.surroundContents(mark);
      } catch {
        // skip nodes that can't be wrapped (split across elements)
      }
    }
  }, [searchQuery, searchCurrentIdx, messages]);

  const hasMessages = messages.length > 0 || showTypingIndicator;

  // Count tool-call steps, running token total, and last tool activity in the current run.
  // Tool calls appear as content blocks (type: tool_use/tool_call) inside assistant messages,
  // and separately as role: tool/toolResult messages — count both.
  const { toolStepCount, runTokenTotal, lastToolLabel } = useMemo(() => {
    let steps = 0;
    let tokens = 0;
    let lastTool = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        break;
      }
      if (msg.role === "tool" || (msg.role as string) === "toolResult") {
        steps++;
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const cards = extractToolCards(msg.content);
        const calls = cards.filter((c) => c.kind === "call");
        steps += calls.length;
        // Capture the most recent tool call name + detail for the activity label
        if (!lastTool && calls.length > 0) {
          const last = calls[calls.length - 1];
          lastTool = last.text ?? last.name;
        }
      }
      if (msg.usage) {
        tokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
      }
    }
    return { toolStepCount: steps, runTokenTotal: tokens, lastToolLabel: lastTool };
  }, [messages]);

  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);

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
      setShowScrollTop(scrollTop > 300);
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMessages]);

  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && !isNearBottomRef.current) {
      setHasNewBelow(true);
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  useEffect(() => {
    setHasNewBelow(false);
    setShowScrollTop(false);
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

  const scrollToTop = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <>
      <ChatHeader
        models={models}
        loadSessions={loadSessions}
        loadHistory={loadHistory}
        switchSession={switchSession}
        agentEmoji={activeAgentEmoji}
        agentName={activeAgentName}
        agentRole={activeAgentRole}
        agentDepartment={activeAgentDepartment}
        onRenameSession={handleRenameSession}
        onToggleSearch={toggleSearch}
        isSearchOpen={searchOpen}
      />

      <ChatLayout
        switchSession={switchSession}
        activeSessionKey={activeSessionKey}
        onNewChat={handleNewChat}
        resetSession={resetSession}
        handleDeleteSession={handleDeleteSession}
        handleRenameSession={handleRenameSession}
        handleArchiveSidebar={handleArchiveSidebar}
        contextPanel={contextPanel}
        onCloseContextPanel={handleCloseContextPanel}
        models={models}
      >
        {/* Content area */}
        <div className="relative flex flex-1 flex-col min-h-0 pt-14 md:pt-0">
          {messagesLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <TextShimmerLoader text="Loading messages..." size="md" />
            </div>
          ) : !hasMessages ? (
            <div className="flex flex-1 items-center justify-center p-4">
              <EmptyState onSuggestionClick={setInputValue} />
            </div>
          ) : (
            <>
              {searchOpen && (
                <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-2 bg-card/90 backdrop-blur border-b border-border/40">
                  <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (e.shiftKey) {
                          searchPrev();
                        } else {
                          searchNext();
                        }
                      }
                      if (e.key === "Escape") {
                        setSearchOpen(false);
                        setSearchQuery("");
                        setSearchCurrentIdx(0);
                      }
                    }}
                    placeholder="Search messages..."
                    className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 outline-none"
                    autoFocus
                  />
                  {searchQuery && searchMatches.length > 0 && (
                    <>
                      <span className="text-xs text-muted-foreground font-mono tabular-nums shrink-0">
                        {searchCurrentIdx + 1} of {searchMatches.length}
                      </span>
                      <button
                        onClick={searchPrev}
                        className="p-1 rounded hover:bg-muted transition-colors"
                        title="Previous match (Shift+Enter)"
                      >
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      <button
                        onClick={searchNext}
                        className="p-1 rounded hover:bg-muted transition-colors"
                        title="Next match (Enter)"
                      >
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                    </>
                  )}
                  {searchQuery && searchMatches.length === 0 && (
                    <span className="text-xs text-muted-foreground/60 font-mono shrink-0">
                      No matches
                    </span>
                  )}
                  <button
                    onClick={() => {
                      setSearchOpen(false);
                      setSearchQuery("");
                      setSearchCurrentIdx(0);
                    }}
                    className="p-1 rounded hover:bg-muted transition-colors"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
              )}
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
                    if (consumedIndices.has(i)) {
                      return null;
                    }
                    // Compute previous assistant's total tokens for delta display.
                    // Only set when a real previous value exists — avoids showing the
                    // full context total as a misleading "+Xk" delta.
                    let prevTokens: number | undefined;
                    if (msg.role === "assistant" && msg.usage) {
                      for (let j = i - 1; j >= 0; j--) {
                        const prev = messages[j];
                        if (prev.role === "assistant" && prev.usage?.totalTokens) {
                          prevTokens = prev.usage.totalTokens;
                          break;
                        }
                      }
                    }
                    // For user messages, compute incremental input token growth
                    // (difference between this turn's input and previous turn's input).
                    // This shows how many tokens the user's message + new context added.
                    let inputTokens: number | undefined;
                    if (msg.role === "user") {
                      let thisInput: number | undefined;
                      let prevInput: number | undefined;
                      // Find the next assistant's input tokens (this turn)
                      for (let j = i + 1; j < messages.length; j++) {
                        const next = messages[j];
                        if (next.role === "assistant" && next.usage?.input) {
                          thisInput = next.usage.input;
                          break;
                        }
                      }
                      // Find the previous assistant's input tokens (last turn)
                      for (let j = i - 1; j >= 0; j--) {
                        const prev = messages[j];
                        if (prev.role === "assistant" && prev.usage?.input) {
                          prevInput = prev.usage.input;
                          break;
                        }
                      }
                      if (thisInput != null && prevInput != null) {
                        const delta = thisInput - prevInput;
                        inputTokens = delta > 0 ? delta : undefined;
                      }
                      // For first user message (no previous turn), don't show — total would be misleading
                    }
                    const isSearchActive = searchQuery.trim() !== "";
                    const isMatch = searchMatchIndices.has(i);
                    const isCurrentMatch = isMatch && searchMatches[searchCurrentIdx] === i;
                    const isSearchDimmed = isSearchActive && !isMatch;
                    return (
                      <div
                        key={msg.id}
                        data-msg-index={i}
                        className={cn(
                          "transition-all duration-200",
                          isSearchDimmed && "opacity-20",
                          isCurrentMatch && "ring-1 ring-primary/40 rounded-lg bg-primary/5",
                        )}
                      >
                        <ChatMessageBubble
                          msg={msg}
                          index={i}
                          rating={ratings[i] ?? null}
                          isLastAssistant={i === lastAssistantIndex}
                          isGroupFirst={isFirstInGroup(messages, i)}
                          toolDisplayMode={toolDisplayMode}
                          mergedToolResults={mergedResults.get(i)}
                          agentEmoji={activeAgentEmoji}
                          agentName={activeAgentName}
                          prevTotalTokens={prevTokens}
                          inputTokens={inputTokens}
                          onRate={handleRate}
                          onRegenerate={handleRegenerate}
                          onViewToolOutput={handleViewToolOutput}
                          onReply={handleReply}
                          onCopyId={handleCopyId}
                          onDelete={handleDeleteMessage}
                          showPlanCard={i === lastPlanMessageIndex}
                        />
                      </div>
                    );
                  })}
                  {showTypingIndicator && (
                    <StreamingBubble
                      content={isStreaming ? streamContent : ""}
                      isGroupFirst={
                        messages.length === 0 ||
                        (messages[messages.length - 1].role !== "assistant" &&
                          messages[messages.length - 1].role !== "tool" &&
                          (messages[messages.length - 1].role as string) !== "toolResult")
                      }
                      paused={isPaused}
                      agentEmoji={activeAgentEmoji}
                      agentName={activeAgentName}
                      stepCount={toolStepCount}
                      runTokens={runTokenTotal}
                      activityLabel={activityLabel || lastToolLabel}
                      onAbort={abortRun}
                      showPlanCard={lastPlanMessageIndex === -1}
                    />
                  )}
                  <div ref={scrollToRef} className="h-4" />
                </div>
              </ChatContainer>
            </>
          )}

          {/* Scroll FABs + New messages indicator */}
          {hasMessages && (
            <div className="absolute bottom-24 right-6 md:right-10 z-30 flex flex-col items-center gap-2">
              {hasNewBelow && (
                <button
                  onClick={scrollToBottom}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground text-xs font-medium shadow-lg shadow-primary/20 hover:bg-primary/90 transition-all animate-slide-in-up"
                >
                  New messages
                  <ArrowDown className="h-3 w-3" />
                </button>
              )}
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 w-8 rounded-full transition-all duration-150 ease-out",
                    showScrollTop
                      ? "translate-y-0 scale-100 opacity-100"
                      : "pointer-events-none translate-y-4 scale-95 opacity-0",
                  )}
                  onClick={scrollToTop}
                  aria-label="Scroll to top"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <PromptScrollButton
                  scrollRef={scrollToRef}
                  containerRef={chatContainerRef}
                  threshold={200}
                />
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <ChatInput
          inputValue={inputValue}
          setInputValue={setInputValue}
          placeholder={placeholder}
          isStreaming={isStreaming}
          isPaused={isPaused}
          sendMessage={sendMessage}
          abortRun={abortRun}
          startQueue={startQueue}
          stopQueue={stopQueue}
          toolDisplayMode={toolDisplayMode}
          setToolDisplayMode={setToolDisplayMode}
          models={models}
        />
      </ChatLayout>
    </>
  );
}
