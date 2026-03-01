import { useState, useEffect } from "react";
import { useChatStore, type ChatState } from "@/store/chat-store";
import { useGatewayStore, type GatewayState } from "@/store/gateway-store";

const IDLE_SUGGESTIONS = [
  "Ask me anything...",
  "Try: summarize a document",
  "Try: write a function that...",
  "Try: explain how this works",
  "Try: compare these options",
  "Ask a follow-up question...",
];

const ROTATION_INTERVAL_MS = 5000;

export function useDynamicPlaceholder(): string {
  const connectionStatus = useGatewayStore((s: GatewayState) => s.connectionStatus);
  const isSendPending = useChatStore((s: ChatState) => s.isSendPending);
  const isStreaming = useChatStore((s: ChatState) => s.isStreaming);
  const isPaused = useChatStore((s: ChatState) => s.isPaused);
  const isQueueRunning = useChatStore((s: ChatState) => s.isQueueRunning);
  const messageQueue = useChatStore((s: ChatState) => s.messageQueue);

  const [idleIndex, setIdleIndex] = useState(0);

  // Determine whether we are in the idle state
  const isIdle =
    connectionStatus === "connected" && !isSendPending && !isStreaming && !isQueueRunning;

  // Rotate idle suggestions every 5 seconds; reset index when entering idle
  useEffect(() => {
    if (!isIdle) {
      setIdleIndex(0);
      return;
    }

    const interval = setInterval(() => {
      setIdleIndex((prev) => (prev + 1) % IDLE_SUGGESTIONS.length);
    }, ROTATION_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isIdle]);

  // Priority-based placeholder selection
  if (connectionStatus !== "connected") {
    return "Reconnecting to gateway...";
  }

  if (isSendPending) {
    return "Sending...";
  }

  if (isStreaming && isPaused) {
    return "Output paused \u2014 type a follow-up...";
  }

  if (isStreaming && !isPaused) {
    return "AI is generating a response...";
  }

  if (isQueueRunning && messageQueue.length > 0) {
    return `Queue running (${messageQueue.length} remaining)...`;
  }

  // Idle — rotating suggestions
  return IDLE_SUGGESTIONS[idleIndex];
}
