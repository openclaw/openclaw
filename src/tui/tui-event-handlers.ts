import type { TUI } from "@mariozechner/pi-tui";
import type { ChatLog } from "./components/chat-log.js";
import {
  asString,
  extractTextFromMessage,
  extractThinkingFromMessage,
  extractContentFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";
import type { AgentEvent, ChatEvent, TuiStateAccess } from "./tui-types.js";

type EventHandlerContext = {
  chatLog: ChatLog;
  tui: TUI;
  state: TuiStateAccess;
  setActivityStatus: (text: string) => void;
  refreshSessionInfo?: () => Promise<void>;
};

/**
 * Per-run stream buffer for tracking thinking/content separately.
 * Enables proper sequencing regardless of network arrival order.
 */
interface RunStreamBuffer {
  thinkingText: string;
  contentText: string;
  lastUpdateMs: number;
}

export function createEventHandlers(context: EventHandlerContext) {
  const { chatLog, tui, state, setActivityStatus, refreshSessionInfo } = context;
  const finalizedRuns = new Map<string, number>();
  // FIXED: Per-run stream buffers for proper isolation
  const runBuffers = new Map<string, RunStreamBuffer>();

  const noteFinalizedRun = (runId: string) => {
    finalizedRuns.set(runId, Date.now());
    runBuffers.delete(runId); // Clean up buffer
    if (finalizedRuns.size <= 200) return;
    const keepUntil = Date.now() - 10 * 60 * 1000;
    for (const [key, ts] of finalizedRuns) {
      if (finalizedRuns.size <= 150) break;
      if (ts < keepUntil) finalizedRuns.delete(key);
    }
    if (finalizedRuns.size > 200) {
      for (const key of finalizedRuns.keys()) {
        finalizedRuns.delete(key);
        if (finalizedRuns.size <= 150) break;
      }
    }
  };

  /**
   * Get or create a stream buffer for a specific runId.
   */
  const getOrCreateBuffer = (runId: string): RunStreamBuffer => {
    let buffer = runBuffers.get(runId);
    if (!buffer) {
      buffer = {
        thinkingText: "",
        contentText: "",
        lastUpdateMs: Date.now(),
      };
      runBuffers.set(runId, buffer);
    }
    return buffer;
  };

  const handleChatEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as ChatEvent;
    if (evt.sessionKey !== state.currentSessionKey) return;
    if (finalizedRuns.has(evt.runId)) {
      if (evt.state === "delta") return;
      if (evt.state === "final") return;
    }
    if (evt.state === "delta") {
      const buffer = getOrCreateBuffer(evt.runId);

      // FIXED: Extract thinking and content SEPARATELY for proper sequencing
      // This is model-agnostic: models without thinking blocks just return empty string
      const thinkingText = extractThinkingFromMessage(evt.message);
      const contentText = extractContentFromMessage(evt.message);

      // Update buffer with new content
      // In streaming, we typically receive the full accumulated text each time
      if (thinkingText) {
        buffer.thinkingText = thinkingText;
      }
      if (contentText) {
        buffer.contentText = contentText;
      }
      buffer.lastUpdateMs = Date.now();

      // Skip render if both are empty
      if (!buffer.thinkingText && !buffer.contentText) return;

      // FIXED: Pass separated streams to ChatLog for proper sequencing
      chatLog.updateAssistant("", evt.runId, {
        thinkingText: buffer.thinkingText,
        contentText: buffer.contentText,
        showThinking: state.showThinking,
      });

      setActivityStatus("streaming");
    }
    if (evt.state === "final") {
      const stopReason =
        evt.message && typeof evt.message === "object" && !Array.isArray(evt.message)
          ? typeof (evt.message as Record<string, unknown>).stopReason === "string"
            ? ((evt.message as Record<string, unknown>).stopReason as string)
            : ""
          : "";

      // FIXED: Extract final content with proper thinking handling
      const thinkingText = extractThinkingFromMessage(evt.message);
      const contentText = extractContentFromMessage(evt.message);

      // Compose final text with proper ordering (thinking before content)
      const parts: string[] = [];
      if (state.showThinking && thinkingText.trim()) {
        parts.push(`[thinking]\n${thinkingText}`);
      }
      if (contentText.trim()) {
        parts.push(contentText);
      }
      const finalComposed = parts.join("\n\n").trim();

      const finalText = resolveFinalAssistantText({
        finalText: finalComposed,
        streamedText: chatLog.getStreamingText(evt.runId),
      });
      chatLog.finalizeAssistant(finalText, evt.runId);
      noteFinalizedRun(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus(stopReason === "error" ? "error" : "idle");
      // Refresh session info to update token counts in footer
      void refreshSessionInfo?.();
    }
    if (evt.state === "aborted") {
      chatLog.addSystem("run aborted");
      runBuffers.delete(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus("aborted");
      void refreshSessionInfo?.();
    }
    if (evt.state === "error") {
      chatLog.addSystem(`run error: ${evt.errorMessage ?? "unknown"}`);
      runBuffers.delete(evt.runId);
      state.activeChatRunId = null;
      setActivityStatus("error");
      void refreshSessionInfo?.();
    }
    tui.requestRender();
  };

  const handleAgentEvent = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const evt = payload as AgentEvent;
    if (!state.currentSessionId || evt.runId !== state.currentSessionId) return;
    if (evt.stream === "tool") {
      const data = evt.data ?? {};
      const phase = asString(data.phase, "");
      const toolCallId = asString(data.toolCallId, "");
      const toolName = asString(data.name, "tool");
      if (!toolCallId) return;
      if (phase === "start") {
        chatLog.startTool(toolCallId, toolName, data.args);
      } else if (phase === "update") {
        chatLog.updateToolResult(toolCallId, data.partialResult, {
          partial: true,
        });
      } else if (phase === "result") {
        chatLog.updateToolResult(toolCallId, data.result, {
          isError: Boolean(data.isError),
        });
      }
      tui.requestRender();
      return;
    }
    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data?.phase === "string" ? evt.data.phase : "";
      if (phase === "start") setActivityStatus("running");
      if (phase === "end") setActivityStatus("idle");
      if (phase === "error") setActivityStatus("error");
      tui.requestRender();
    }
  };

  return { handleChatEvent, handleAgentEvent };
}
