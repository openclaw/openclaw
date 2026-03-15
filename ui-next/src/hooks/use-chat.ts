import { useCallback, useEffect, useRef } from "react";
import { onAgentPushEvent } from "@/hooks/use-gateway";
import { generateUUID } from "@/lib/uuid";
import {
  useChatStore,
  normalizeSessionKey,
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
  // Only auto-redirect to the most-recently-active session on the very first
  // loadSessions call (initial page load). After that, respect the user's
  // explicit session choice — e.g. "New Chat" creates a key that doesn't
  // exist in the server list yet; we must not override it.
  const initialSessionResolvedRef = useRef(false);

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

      // Normalize or auto-select the active session:
      // 1. If the current key matches exactly — keep it.
      // 2. If the current key has a canonical form (e.g. "main" → "agent:main:main") — use that.
      // 3. On initial page load only: if the current key still can't be resolved
      //    (e.g. default "main" with no such session), fall back to the most recently
      //    active session so the user isn't left on a blank screen.
      const currentKey = store.activeSessionKey;
      const exactMatch = sessions.find((s) => s.key === currentKey);
      if (!exactMatch) {
        const canonical = sessions.find((s) => s.key.endsWith(`:${currentKey}`));
        if (canonical) {
          // Migrate optimistic state (user message + sendPending) to the canonical key
          // so the user's message isn't lost when the session key resolves.
          const oldState = store.getSessionState(currentKey);
          if (oldState.messages.length > 0 || oldState.isSendPending || oldState.isStreaming) {
            const newState = store.getSessionState(canonical.key);
            if (newState.messages.length === 0) {
              store.setMessages(oldState.messages, undefined, canonical.key);
              if (oldState.isSendPending) {
                store.setSendPending(true, canonical.key);
              }
              if (oldState.isStreaming && oldState.streamRunId) {
                store.startStream(oldState.streamRunId, canonical.key);
              }
            }
          }
          store.setActiveSessionKey(canonical.key);
        } else if (sessions.length > 0 && !initialSessionResolvedRef.current) {
          // First load only — auto-select the most recently active session (sessions are
          // sorted by updatedAt desc from the gateway).
          store.setActiveSessionKey(sessions[0].key);
        }
      }
      initialSessionResolvedRef.current = true;
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
    // Capture the session key at call time — it must not drift during the async RPC.
    const capKey = activeSessionKey;
    const seq = ++historySeqRef.current;
    const store = useChatStore.getState();
    // Only show loading spinner when there are no messages yet AND no send is
    // pending (the user just sent an optimistic message — don't flash a spinner).
    const sessState = store.getSessionState(capKey);
    const isInitialLoad = sessState.messages.length === 0 && !sessState.isSendPending;
    if (isInitialLoad) {
      store.setMessagesLoading(true, capKey);
    }
    try {
      const result = await sendRpc<{
        messages: ChatMessage[];
        thinkingLevel?: string;
        isRunning?: boolean;
      }>("chat.history", {
        sessionKey: capKey,
        limit: 200,
      });
      // Discard if a newer loadHistory call has superseded this one
      if (seq !== historySeqRef.current) {
        return;
      }
      store.setMessages(result?.messages ?? [], result?.isRunning, capKey);
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
        useChatStore.getState().setMessagesLoading(false, capKey);
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

      // Capture the session key at call time — it must not drift during the async RPC.
      const capKey = activeSessionKey;
      const store = useChatStore.getState();

      // Optimistically add user message
      store.appendMessage(
        {
          role: "user",
          content: content as string | import("@/store/chat-store").ChatMessageContent[],
          timestamp: Date.now(),
          seq: 0,
        },
        capKey,
      );

      // Show typing indicator immediately (dots appear before server acks).
      // This is separate from streaming state so it doesn't block real events.
      store.setSendPending(true, capKey);

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
          sessionKey: capKey,
          message,
          attachments,
          idempotencyKey: generateUUID(),
        });
        // Apply pending model if set (e.g. model was selected before first send in a new session).
        const pendingModelId = useChatStore.getState().pendingModelId;
        if (pendingModelId) {
          useChatStore.getState().setPendingModelId(null);
          void sendRpc("sessions.patch", { key: capKey, model: pendingModelId });
        }
        // Refresh session list so the new session appears in the sidebar immediately.
        void loadSessions();
        // Re-fetch after a short delay so the derived title (from transcript) is available.
        setTimeout(() => void loadSessions(), 2500);
        // Capture runId so abort works before the first delta event.
        // Guard: only start the stream if the gateway event handler hasn't
        // already started AND finalized it while we awaited the RPC response.
        // Without this check, a fast response causes startStream to re-arm
        // isStreaming after finalizeStream already cleared it, leaving the
        // stream (and queue) stuck forever.
        if (res?.runId) {
          const s = useChatStore.getState();
          const sessState = s.getSessionState(capKey);
          if (!sessState.streamRunId && !sessState.isStreaming) {
            // No stream active and none finalized during await — safe to start
            s.startStream(res.runId, capKey);
          } else if (sessState.streamRunId === res.runId) {
            // Already tracking this run (gateway event arrived first) — no-op
          }
          // Otherwise: stream already finalized (streamRunId null, isStreaming
          // was true→false during await) — do NOT re-arm.
        }
      } catch (err) {
        console.error("[chat] send failed:", err);
        // Clear the pending typing indicator on failure
        useChatStore.getState().setSendPending(false, capKey);
        store.appendMessage(
          {
            role: "system",
            content: `Failed to send message: ${err instanceof Error ? err.message : "unknown error"}`,
            timestamp: Date.now(),
            seq: 0,
          },
          capKey,
        );
        throw err;
      }
    },
    [sendRpc, isConnected, activeSessionKey, loadSessions],
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
    const sessState = store.getSessionState(activeSessionKey);
    // Clear streaming UI immediately for responsive feel
    if (sessState.isStreaming || sessState.isSendPending) {
      store.finalizeStream(
        sessState.streamRunId ?? "",
        activeSessionKey,
        sessState.streamContent || undefined,
      );
    }
    try {
      await sendRpc("chat.abort", {
        sessionKey: activeSessionKey,
        runId: sessState.streamRunId ?? undefined,
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
          useChatStore.getState().setMessages([], undefined, key);
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
    const activeKey = s.activeSessionKey;
    const sessState = s.getSessionState(activeKey);
    if (sessState.isStreaming || sessState.isSendPending) {
      // Defense-in-depth: detect stuck streams and force-clear them.
      // Case 1: isStreaming with no streamRunId (re-armed after finalize).
      // Case 2: isStreaming but no stream events received for 30s+ (server
      //         finished but the "final" event was dropped).
      const stuckNoRunId = sessState.isStreaming && !sessState.streamRunId;
      const staleStream =
        sessState.isStreaming &&
        sessState.lastStreamEventAt > 0 &&
        Date.now() - sessState.lastStreamEventAt > 30_000;
      if (stuckNoRunId || staleStream) {
        // Force-clear by finalizing the stuck stream; state change triggers subscriber
        s.finalizeStream(sessState.streamRunId ?? "", activeKey, undefined);
        return;
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

      // Read per-session streaming state for the active session.
      // We use state.activeSessionKey (not a closure var) so this always
      // reflects the most recently active session.
      const activeKey = state.activeSessionKey;
      const curSess = state.sessionStates.get(activeKey);
      const prevSess = prev.sessionStates.get(activeKey) ?? curSess;

      // Detect completion: streaming finished OR sendPending cleared with no stream active.
      // The sendPending check handles the case where the stream was already finalized
      // by the gateway event handler before the sendMessage RPC resolved.
      const streamJustFinished =
        (prevSess?.isStreaming ?? false) && !(curSess?.isStreaming ?? false);
      const pendingJustCleared =
        (prevSess?.isSendPending ?? false) &&
        !(curSess?.isSendPending ?? false) &&
        !(curSess?.isStreaming ?? false);

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
      const sessState = s.getSessionState(s.activeSessionKey);
      if (!sessState.isStreaming && !sessState.isSendPending) {
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
    const sessState = store.getSessionState(store.activeSessionKey);
    if (!sessState.isStreaming && !sessState.isSendPending) {
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
    const sessState = s.getSessionState(s.activeSessionKey);
    if (sessState.isStreaming || sessState.isSendPending) {
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
      const activeKey = s.activeSessionKey;
      const sessState = s.getSessionState(activeKey);
      if (!sessState.isStreaming || !sessState.lastStreamEventAt) {
        return;
      }
      // Server-side polling confirmed the agent is still running — don't clear
      if (sessState.isAgentActive) {
        return;
      }
      if (Date.now() - sessState.lastStreamEventAt > 60_000) {
        console.warn("[chat] stale stream detected — clearing stuck thinking state");
        s.finalizeStream(
          sessState.streamRunId ?? "",
          activeKey,
          sessState.streamContent || undefined,
        );
      }
    }, 10_000);
    return () => clearInterval(watchdog);
  }, []);

  // Refresh sessions after each stream completes so the header title and sidebar
  // update with the gateway-generated derived title (no page refresh needed).
  useEffect(() => {
    const unsub = useChatStore.subscribe((state: ChatState, prev: ChatState) => {
      const activeKey = state.activeSessionKey;
      const curSess = state.sessionStates.get(activeKey);
      const prevSess = prev.sessionStates.get(activeKey);
      const streamJustFinished =
        (prevSess?.isStreaming ?? false) && !(curSess?.isStreaming ?? false);
      if (streamJustFinished) {
        void loadSessions();
      }
    });
    return unsub;
  }, [loadSessions]);

  // Listen for agent tool-start events pushed via WebSocket (requires "tool-events" cap).
  // These arrive faster than polling and update the activity label in real-time.
  useEffect(() => {
    const unsub = onAgentPushEvent((payload: unknown) => {
      const evt = payload as {
        stream?: string;
        sessionKey?: string;
        data?: { phase?: string; name?: string; args?: Record<string, unknown> };
      };
      if (evt.stream !== "tool" || evt.data?.phase !== "start") {
        return;
      }
      const sessionKey = evt.sessionKey;
      if (!sessionKey) {
        return;
      }
      const store = useChatStore.getState();
      const key = normalizeSessionKey(sessionKey);
      const toolName = evt.data.name ?? "";
      const args = evt.data.args;
      let label = toolName;
      if (toolName === "exec" && typeof args?.command === "string") {
        label = String(args.command).slice(0, 120);
      } else if (
        (toolName === "read" || toolName === "write") &&
        typeof (args?.path ?? args?.file_path) === "string"
      ) {
        label = `${toolName}: ${String(args?.path ?? args?.file_path).slice(0, 120)}`;
      } else if (toolName === "search" && typeof args?.query === "string") {
        label = `search: ${String(args.query).slice(0, 120)}`;
      }
      store.setActivityLabel(label, key);
    });
    return unsub;
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
  const isStreaming = useChatStore((s) => s.getSessionState(s.activeSessionKey).isStreaming);
  const isSendPending = useChatStore((s) => s.getSessionState(s.activeSessionKey).isSendPending);
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
