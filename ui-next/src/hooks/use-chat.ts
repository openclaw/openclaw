import { useCallback, useEffect, useRef } from "react";
import { generateUUID } from "@/lib/uuid";
import {
  useChatStore,
  type ChatMessage,
  type ChatState,
  type SessionEntry,
} from "@/store/chat-store";
import { useGatewayStore } from "@/store/gateway-store";

type SendRpc = <T = unknown>(method: string, params?: unknown) => Promise<T>;

export function useChat(sendRpc: SendRpc) {
  const activeSessionKey = useChatStore((s) => s.activeSessionKey);
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // Sequence counters to guard against stale async responses.
  // When a new request starts, the counter increments; if the counter has
  // moved on by the time the response arrives, we discard it.
  const historySeqRef = useRef(0);
  const sessionsSeqRef = useRef(0);

  // Load sessions on connect
  const loadSessions = useCallback(async () => {
    if (!isConnected) {
      return;
    }
    const seq = ++sessionsSeqRef.current;
    const store = useChatStore.getState();
    store.setSessionsLoading(true);
    try {
      const result = await sendRpc<{ sessions: SessionEntry[] }>("sessions.list", {
        limit: 50,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      // Discard if a newer request has been issued
      if (seq !== sessionsSeqRef.current) {
        return;
      }
      const sessions = result?.sessions ?? [];
      store.setSessions(sessions);

      // Normalize activeSessionKey to match the canonical key format returned by
      // the gateway (e.g. "main" → "agent:main:main").  This ensures the UI can
      // look up the active session and display its model override correctly.
      const currentKey = store.activeSessionKey;
      if (currentKey && !sessions.find((s) => s.key === currentKey)) {
        const canonical = sessions.find((s) => s.key.endsWith(`:${currentKey}`));
        if (canonical) {
          store.setActiveSessionKey(canonical.key);
        }
      }
    } catch (err) {
      if (seq !== sessionsSeqRef.current) {
        return;
      }
      console.error("[chat] failed to load sessions:", err);
    } finally {
      if (seq === sessionsSeqRef.current) {
        useChatStore.getState().setSessionsLoading(false);
      }
    }
  }, [sendRpc, isConnected]);

  // Load message history for active session
  const loadHistory = useCallback(async () => {
    if (!isConnected || !activeSessionKey) {
      return;
    }
    const seq = ++historySeqRef.current;
    const store = useChatStore.getState();
    // Only show loading spinner when there are no messages yet (initial load).
    // Reconnect-triggered reloads should not flash the spinner.
    const isInitialLoad = store.messages.length === 0;
    if (isInitialLoad) {
      store.setMessagesLoading(true);
    }
    try {
      const result = await sendRpc<{
        messages: ChatMessage[];
        thinkingLevel?: string;
      }>("chat.history", {
        sessionKey: activeSessionKey,
        limit: 200,
      });
      // Discard if a newer loadHistory call has superseded this one
      if (seq !== historySeqRef.current) {
        return;
      }
      store.setMessages(result?.messages ?? []);
      if (result?.thinkingLevel) {
        store.setThinkingLevel(result.thinkingLevel);
      }
    } catch (err) {
      if (seq !== historySeqRef.current) {
        return;
      }
      console.error("[chat] failed to load history:", err);
      // Don't wipe existing messages on error — keep what we have
    } finally {
      if (seq === historySeqRef.current) {
        useChatStore.getState().setMessagesLoading(false);
      }
    }
  }, [sendRpc, isConnected, activeSessionKey]);

  // Send a message (plain text or structured content blocks for multimodal)
  const sendMessage = useCallback(
    async (content: string | Array<unknown>) => {
      // For plain text, require non-empty; for structured content, require at least one block
      if (typeof content === "string" && !content.trim()) {
        return;
      }
      if (Array.isArray(content) && content.length === 0) {
        return;
      }
      if (!isConnected) {
        return;
      }

      const store = useChatStore.getState();

      // Optimistically add user message
      store.appendMessage({
        role: "user",
        content: content as string | import("@/store/chat-store").ChatMessageContent[],
        timestamp: Date.now(),
      });

      // Show typing indicator immediately (dots appear before server acks).
      // This is separate from streaming state so it doesn't block real events.
      store.setSendPending(true);

      // The server expects message: string + attachments: array.
      // When content is an array of structured blocks (text + images), split them.
      let message: string;
      let attachments: Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        const textParts: string[] = [];
        const imageBlocks: Array<Record<string, unknown>> = [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          } else if (b.type === "image") {
            const source = b.source as Record<string, unknown> | undefined;
            imageBlocks.push({
              type: "image",
              mimeType: source?.media_type,
              content: source?.data,
            });
          }
        }
        message = textParts.join("\n") || " ";
        attachments = imageBlocks.length > 0 ? imageBlocks : undefined;
      } else {
        message = content;
      }

      try {
        const res = await sendRpc<{ runId?: string }>("chat.send", {
          sessionKey: activeSessionKey,
          message,
          attachments,
          idempotencyKey: generateUUID(),
        });
        // Capture runId immediately so abort works before the first delta event
        if (res?.runId) {
          const s = useChatStore.getState();
          if (!s.streamRunId) {
            s.startStream(res.runId);
          }
        }
      } catch (err) {
        console.error("[chat] send failed:", err);
        // Clear the pending typing indicator on failure
        useChatStore.getState().setSendPending(false);
        store.appendMessage({
          role: "system",
          content: `Failed to send message: ${err instanceof Error ? err.message : "unknown error"}`,
          timestamp: Date.now(),
        });
        throw err;
      }
    },
    [sendRpc, isConnected, activeSessionKey],
  );

  // Abort current run (works with or without a known runId).
  // Also stops the queue so it doesn't auto-send the next item.
  const abortRun = useCallback(async () => {
    if (!activeSessionKey) {
      return;
    }
    const store = useChatStore.getState();
    // Stop queue on abort — user must explicitly restart
    if (store.isQueueRunning) {
      store.setQueueRunning(false);
    }
    // Clear streaming UI immediately for responsive feel
    if (store.isStreaming || store.isSendPending) {
      store.finalizeStream(store.streamRunId ?? "", store.streamContent || undefined);
    }
    try {
      await sendRpc("chat.abort", {
        sessionKey: activeSessionKey,
        runId: store.streamRunId ?? undefined,
      });
    } catch (err) {
      console.error("[chat] abort failed:", err);
    }
  }, [sendRpc, activeSessionKey]);

  // Switch session
  const switchSession = useCallback((key: string) => {
    useChatStore.getState().setActiveSessionKey(key);
  }, []);

  // Reset session
  const resetSession = useCallback(
    async (key: string) => {
      try {
        await sendRpc("sessions.reset", { key });
        if (key === activeSessionKey) {
          useChatStore.getState().setMessages([]);
        }
        await loadSessions();
      } catch (err) {
        console.error("[chat] reset session failed:", err);
      }
    },
    [sendRpc, activeSessionKey, loadSessions],
  );

  // Delete session
  const deleteSession = useCallback(
    async (key: string) => {
      try {
        await sendRpc("sessions.delete", { key });
        await loadSessions();
        // If the deleted session was active, switch to "main" or the first available session
        const store = useChatStore.getState();
        if (key === store.activeSessionKey) {
          const remaining = store.sessions;
          const fallback = remaining.find((s) => s.key === "main")
            ? "main"
            : (remaining[0]?.key ?? "main");
          store.setActiveSessionKey(fallback);
        }
      } catch (err) {
        console.error("[chat] delete session failed:", err);
      }
    },
    [sendRpc, loadSessions],
  );

  // ─── Queue executor ───
  // Subscribe to streaming state: when a run finishes and the queue is running,
  // auto-send the next message after a short delay.
  const queueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = useChatStore.subscribe((state: ChatState, prev: ChatState) => {
      // Detect stream completion: was streaming → no longer streaming
      const justFinished = prev.isStreaming && !state.isStreaming;
      if (!justFinished) {
        return;
      }
      if (!state.isQueueRunning) {
        return;
      }
      if (state.messageQueue.length === 0) {
        // Queue drained
        state.setQueueRunning(false);
        return;
      }

      // Small delay to let UI settle and avoid race conditions
      queueTimerRef.current = setTimeout(() => {
        const s = useChatStore.getState();
        if (!s.isQueueRunning || s.isStreaming || s.isSendPending) {
          return;
        }

        const next = s.dequeueNext();
        if (!next) {
          s.setQueueRunning(false);
          return;
        }

        // Remove the item from the queue now that we're sending it
        s.removeFromQueue(next.id);

        // Send via the same sendMessage path
        sendMessage(next.content).catch((err) => {
          console.error("[queue] failed to send queued message:", err);
          useChatStore.getState().setQueueRunning(false);
        });
      }, 500);
    });

    return () => {
      unsub();
      if (queueTimerRef.current) {
        clearTimeout(queueTimerRef.current);
      }
    };
  }, [sendMessage]);

  // Start queue execution — if not currently streaming, send the first item now
  const startQueue = useCallback(() => {
    const store = useChatStore.getState();
    if (store.messageQueue.length === 0) {
      return;
    }
    store.setQueueRunning(true);

    // If idle (not streaming), kick off the first item immediately
    if (!store.isStreaming && !store.isSendPending) {
      const next = store.dequeueNext();
      if (!next) {
        return;
      }
      store.removeFromQueue(next.id);
      sendMessage(next.content).catch((err) => {
        console.error("[queue] failed to start queue:", err);
        useChatStore.getState().setQueueRunning(false);
      });
    }
    // If currently streaming, the useEffect subscriber above will pick up the next
    // item when the current run completes.
  }, [sendMessage]);

  const stopQueue = useCallback(() => {
    useChatStore.getState().setQueueRunning(false);
  }, []);

  // Auto-load sessions when connected
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Auto-load history when session changes
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  return {
    sendMessage,
    abortRun,
    startQueue,
    stopQueue,
    loadSessions,
    loadHistory,
    switchSession,
    resetSession,
    deleteSession,
  };
}
