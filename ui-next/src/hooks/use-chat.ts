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
        isRunning?: boolean;
      }>("chat.history", {
        sessionKey: activeSessionKey,
        limit: 200,
      });
      // Discard if a newer loadHistory call has superseded this one
      if (seq !== historySeqRef.current) {
        return;
      }
      store.setMessages(result?.messages ?? [], result?.isRunning);
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
        seq: 0,
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
        // Capture runId so abort works before the first delta event.
        // Guard: only start the stream if the gateway event handler hasn't
        // already started AND finalized it while we awaited the RPC response.
        // Without this check, a fast response causes startStream to re-arm
        // isStreaming after finalizeStream already cleared it, leaving the
        // stream (and queue) stuck forever.
        if (res?.runId) {
          const s = useChatStore.getState();
          if (!s.streamRunId && !s.isStreaming) {
            // No stream active and none finalized during await — safe to start
            s.startStream(res.runId);
          } else if (s.streamRunId === res.runId) {
            // Already tracking this run (gateway event arrived first) — no-op
          }
          // Otherwise: stream already finalized (streamRunId null, isStreaming
          // was true→false during await) — do NOT re-arm.
        }
      } catch (err) {
        console.error("[chat] send failed:", err);
        // Clear the pending typing indicator on failure
        useChatStore.getState().setSendPending(false);
        store.appendMessage({
          role: "system",
          content: `Failed to send message: ${err instanceof Error ? err.message : "unknown error"}`,
          timestamp: Date.now(),
          seq: 0,
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

  // Helper: attempt to send the next queued message.
  // Extracted so both the subscriber and the fallback timer can use it.
  const trySendNextQueued = useCallback(() => {
    const s = useChatStore.getState();
    if (!s.isQueueRunning) {
      return;
    }
    if (s.isStreaming || s.isSendPending) {
      // Defense-in-depth: detect stuck streams and force-clear them.
      // Case 1: isStreaming with no streamRunId (re-armed after finalize).
      // Case 2: isStreaming but no stream events received for 30s+ (server
      //         finished but the "final" event was dropped, e.g. session key mismatch).
      const stuckNoRunId = s.isStreaming && !s.streamRunId;
      const staleStream =
        s.isStreaming && s.lastStreamEventAt > 0 && Date.now() - s.lastStreamEventAt > 30_000;
      if (stuckNoRunId || staleStream) {
        useChatStore.setState({
          isStreaming: false,
          isSendPending: false,
          streamRunId: null,
          lastStreamEventAt: 0,
        });
        return; // State change triggers subscriber, which will call us again
      }
      return;
    }
    if (s.messageQueue.length === 0) {
      s.setQueueRunning(false);
      return;
    }

    const next = s.dequeueNext();
    if (!next) {
      s.setQueueRunning(false);
      return;
    }

    s.removeFromQueue(next.id);
    sendMessage(next.content).catch((err) => {
      console.error("[queue] failed to send queued message:", err);
      useChatStore.getState().setQueueRunning(false);
    });
  }, [sendMessage]);

  useEffect(() => {
    const unsub = useChatStore.subscribe((state: ChatState, prev: ChatState) => {
      if (!state.isQueueRunning) {
        return;
      }

      // Detect completion: streaming finished OR sendPending cleared with no stream active.
      // The sendPending check handles the case where the stream was already finalized
      // by the gateway event handler before the sendMessage RPC resolved.
      const streamJustFinished = prev.isStreaming && !state.isStreaming;
      const pendingJustCleared = prev.isSendPending && !state.isSendPending && !state.isStreaming;

      if (!streamJustFinished && !pendingJustCleared) {
        return;
      }

      if (state.messageQueue.length === 0) {
        state.setQueueRunning(false);
        return;
      }

      // Small delay to let UI settle and avoid race conditions
      if (queueTimerRef.current) {
        clearTimeout(queueTimerRef.current);
      }
      queueTimerRef.current = setTimeout(trySendNextQueued, 500);
    });

    // Fallback: poll every 3s to catch stuck queue states.
    // The subscriber can miss transitions due to batched state updates or
    // race conditions between finalizeStream and removeFromQueue.
    const fallbackInterval = setInterval(() => {
      const s = useChatStore.getState();
      if (!s.isQueueRunning || s.messageQueue.length === 0) {
        return;
      }
      if (!s.isStreaming && !s.isSendPending) {
        trySendNextQueued();
      }
    }, 3000);

    return () => {
      unsub();
      clearInterval(fallbackInterval);
      if (queueTimerRef.current) {
        clearTimeout(queueTimerRef.current);
      }
    };
  }, [sendMessage, trySendNextQueued]);

  // Start queue execution — if not currently streaming, send the first item now
  const startQueue = useCallback(() => {
    const store = useChatStore.getState();
    if (store.messageQueue.length === 0) {
      return;
    }
    store.setQueueRunning(true);

    // If idle (not streaming), kick off the first item immediately
    if (!store.isStreaming && !store.isSendPending) {
      trySendNextQueued();
    }
    // If currently streaming, the useEffect subscriber above will pick up the next
    // item when the current run completes.
  }, [trySendNextQueued]);

  const stopQueue = useCallback(() => {
    useChatStore.getState().setQueueRunning(false);
  }, []);

  // On mount: if queue was restored from localStorage with pending items,
  // auto-start dispatch once the gateway connection is established.
  // The subscriber only triggers on state transitions, so a restored
  // queue needs an explicit startup nudge after page refresh.
  const queueBootRef = useRef(false);
  useEffect(() => {
    if (queueBootRef.current) {
      return;
    }
    const s = useChatStore.getState();
    if (!isConnected || s.messageQueue.length === 0) {
      return;
    }
    if (s.isStreaming || s.isSendPending) {
      return;
    }
    queueBootRef.current = true;
    s.setQueueRunning(true);
    // Small delay so WS is fully ready
    const timer = setTimeout(trySendNextQueued, 800);
    return () => clearTimeout(timer);
  }, [isConnected, trySendNextQueued]);

  // Watchdog: auto-clear stuck "thinking" indicator if no stream events for 60s.
  // This catches cases where the gateway "final" event was dropped (e.g. session
  // key format mismatch) and isStreaming stays true indefinitely.
  // Skip if isAgentActive — the server confirmed the run is still in-flight.
  useEffect(() => {
    const watchdog = setInterval(() => {
      const s = useChatStore.getState();
      if (!s.isStreaming || !s.lastStreamEventAt) {
        return;
      }
      // Server-side polling confirmed the agent is still running — don't clear
      if (s.isAgentActive) {
        return;
      }
      if (Date.now() - s.lastStreamEventAt > 60_000) {
        console.warn("[chat] stale stream detected — clearing stuck thinking state");
        s.finalizeStream(s.streamRunId ?? "", s.streamContent || undefined);
      }
    }, 10_000);
    return () => clearInterval(watchdog);
  }, []);

  // Auto-load sessions when connected
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Auto-load history when session changes
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Live-poll: periodically reload history while viewing a session.
  // The gateway only pushes text deltas as "chat" events — tool calls,
  // web fetches, and other intermediate steps don't generate events
  // visible to the UI. Polling at a low frequency ensures background
  // activity shows up without needing a manual page refresh.
  // Poll faster (3s) when streaming is active, slower (8s) otherwise.
  const isStreaming = useChatStore((s) => s.isStreaming);
  const isSendPending = useChatStore((s) => s.isSendPending);
  useEffect(() => {
    if (!isConnected || !activeSessionKey) {
      return;
    }
    const intervalMs = isStreaming || isSendPending ? 3000 : 8000;
    const poll = setInterval(() => {
      void loadHistory();
    }, intervalMs);
    return () => clearInterval(poll);
  }, [isStreaming, isSendPending, isConnected, activeSessionKey, loadHistory]);

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
