import { ArrowDown, ArrowUp } from "lucide-react";
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

  const messages = useChatStore((s) => s.messages);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const isStreamingRaw = useChatStore((s) => s.isStreaming);
  const isAgentActive = useChatStore((s) => s.isAgentActive);
  // Treat background agent activity the same as streaming for UI indicators
  const isStreaming = isStreamingRaw || isAgentActive;
  const isPaused = useChatStore((s) => s.isPaused);
  const isSendPending = useChatStore((s) => s.isSendPending);
  const streamContent = useChatStore((s) => s.streamContent);
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
  const hasMessages = messages.length > 0 || showTypingIndicator;

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
              <div className="mx-auto w-full max-w-4xl py-6 md:py-10" role="log" aria-live="polite">
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
                      agentEmoji={activeAgentEmoji}
                      agentName={activeAgentName}
                      prevTotalTokens={prevTokens}
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
                        messages[messages.length - 1].role !== "tool" &&
                        (messages[messages.length - 1].role as string) !== "toolResult")
                    }
                    paused={isPaused}
                    agentEmoji={activeAgentEmoji}
                    agentName={activeAgentName}
                  />
                )}
                <div ref={scrollToRef} className="h-4" />
              </div>
            </ChatContainer>
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
