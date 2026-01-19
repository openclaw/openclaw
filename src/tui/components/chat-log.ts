import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

/**
 * Per-run streaming state - isolates each run's thinking and content streams.
 * This enables proper sequencing regardless of network arrival order.
 */
interface StreamingRunState {
  component: AssistantMessageComponent;
  thinkingText: string;
  contentText: string;
  showThinking: boolean;
}

export class ChatLog extends Container {
  private toolById = new Map<string, ToolExecutionComponent>();
  // FIXED: Replace single streaming fields with per-runId Map for proper isolation
  private streamingRuns = new Map<string, StreamingRunState>();
  // Keep reference to most recent run for backward compatibility
  private lastStreamingRunId: string | null = null;
  private toolsExpanded = false;

  clearAll() {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
    this.lastStreamingRunId = null;
  }

  addSystem(text: string) {
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.system(text), 1, 0));
  }

  addUser(text: string) {
    this.addChild(new UserMessageComponent(text));
  }

  /**
   * Get or create streaming state for a specific runId.
   */
  private getOrCreateRunState(runId: string, showThinking: boolean): StreamingRunState {
    let state = this.streamingRuns.get(runId);
    if (!state) {
      const component = new AssistantMessageComponent("");
      this.addChild(component);
      state = {
        component,
        thinkingText: "",
        contentText: "",
        showThinking,
      };
      this.streamingRuns.set(runId, state);
      this.lastStreamingRunId = runId;
    }
    return state;
  }

  /**
   * Compose the final display text from thinking + content.
   * FIXED: Ensures thinking always appears before content regardless of arrival order.
   */
  private composeDisplayText(state: StreamingRunState): string {
    const parts: string[] = [];

    // Thinking comes first (if enabled and present)
    if (state.showThinking && state.thinkingText.trim()) {
      parts.push(`[thinking]\n${state.thinkingText}`);
    }

    // Content comes after thinking
    if (state.contentText.trim()) {
      parts.push(state.contentText);
    }

    return parts.join("\n\n").trim() || "";
  }

  startAssistant(text: string, runId?: string) {
    const component = new AssistantMessageComponent(text);
    if (runId) {
      // Create proper streaming state for tracked runs
      this.streamingRuns.set(runId, {
        component,
        thinkingText: "",
        contentText: text,
        showThinking: false,
      });
      this.lastStreamingRunId = runId;
    }
    this.addChild(component);
    return component;
  }

  /**
   * Update the assistant message with new streaming content.
   * FIXED: Now properly isolates by runId and separates thinking/content.
   */
  updateAssistant(
    text: string,
    runId?: string,
    options?: {
      thinkingText?: string;
      contentText?: string;
      showThinking?: boolean;
    },
  ) {
    const effectiveRunId = runId ?? "default";
    const showThinking = options?.showThinking ?? false;
    const state = this.getOrCreateRunState(effectiveRunId, showThinking);

    // Update thinking and/or content separately if provided
    if (options?.thinkingText !== undefined) {
      state.thinkingText = options.thinkingText;
    }
    if (options?.contentText !== undefined) {
      state.contentText = options.contentText;
    }

    // If only raw text provided (backward compatibility), use as content
    if (options?.thinkingText === undefined && options?.contentText === undefined) {
      state.contentText = text;
    }

    state.showThinking = showThinking;

    // Recompose and render with guaranteed ordering
    const displayText = this.composeDisplayText(state);
    state.component.setText(displayText);
  }

  getStreamingText(runId?: string) {
    const effectiveRunId = runId ?? this.lastStreamingRunId;
    if (!effectiveRunId) return null;

    const state = this.streamingRuns.get(effectiveRunId);
    if (!state) return null;

    return this.composeDisplayText(state);
  }

  /**
   * Get the raw streaming state (for diagnostics).
   */
  getStreamingState(runId: string): { thinking: string; content: string } | null {
    const state = this.streamingRuns.get(runId);
    if (!state) return null;
    return {
      thinking: state.thinkingText,
      content: state.contentText,
    };
  }

  finalizeAssistant(text: string, runId?: string) {
    const effectiveRunId = runId ?? this.lastStreamingRunId;
    const state = effectiveRunId ? this.streamingRuns.get(effectiveRunId) : null;

    if (state) {
      // Use the final text, or compose from existing state if final is empty
      const finalText = text.trim() || this.composeDisplayText(state);
      state.component.setText(finalText);
    } else {
      // No existing state - create a new component with final text
      this.startAssistant(text, runId);
    }

    // Clean up the streaming state for this run
    if (effectiveRunId) {
      this.streamingRuns.delete(effectiveRunId);
      if (this.lastStreamingRunId === effectiveRunId) {
        this.lastStreamingRunId = null;
      }
    }
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.addChild(component);
    return component;
  }

  updateToolArgs(toolCallId: string, args: unknown) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    existing.setArgs(args);
  }

  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ) {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    if (opts?.partial) {
      existing.setPartialResult(result as Record<string, unknown>);
      return;
    }
    existing.setResult(result as Record<string, unknown>, {
      isError: opts?.isError,
    });
  }

  setToolsExpanded(expanded: boolean) {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }
}
