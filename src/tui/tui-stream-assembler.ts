// Assembles streamed backend events into TUI-visible messages.
import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

const MAX_TRACKED_STREAM_RUNS = 200;

// Per-run state used to merge streaming deltas with final assistant messages.
type RunStreamState = {
  thinkingText: string;
  contentText: string;
  displayText: string;
};

/** Assembles assistant stream deltas and final messages into stable TUI display text. */
export class TuiStreamAssembler {
  private readonly runs = new Map<string, RunStreamState>();

  constructor(private readonly isProtectedRun?: (runId: string) => boolean) {}

  private createRunState(): RunStreamState {
    return {
      thinkingText: "",
      contentText: "",
      displayText: "",
    };
  }

  private getTrackedRun(runId: string): RunStreamState {
    const existing = this.runs.get(runId);
    if (existing) {
      // Keep a still-streaming older run ahead of abandoned runs in eviction order.
      this.runs.delete(runId);
      this.runs.set(runId, existing);
      return existing;
    }

    const state = this.createRunState();
    this.runs.set(runId, state);
    if (this.runs.size > MAX_TRACKED_STREAM_RUNS) {
      // A run can pause while a tool executes; unrelated deltas must not evict
      // the partial reply that its eventual empty final still needs to render.
      for (const trackedRunId of this.runs.keys()) {
        if (this.runs.size <= MAX_TRACKED_STREAM_RUNS) {
          break;
        }
        if (!this.isProtectedRun?.(trackedRunId)) {
          this.runs.delete(trackedRunId);
        }
      }
    }
    return state;
  }

  private updateRunState(state: RunStreamState, message: unknown, showThinking: boolean) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);

    if (thinkingText) {
      state.thinkingText = thinkingText;
    }
    if (contentText) {
      state.contentText = contentText;
    }

    const displayText = composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: state.contentText,
      showThinking,
    });

    state.displayText = displayText;
  }

  /** Ingests a streaming delta and returns updated display text only when it changed. */
  ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
    const state = this.getTrackedRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking);

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  /** Reports whether a run already has real displayable streamed content. */
  hasDisplayText(runId: string): boolean {
    return Boolean(this.runs.get(runId)?.displayText);
  }

  /** Finalizes a run, combines any error text, and drops stored stream state. */
  finalize(runId: string, message: unknown, showThinking: boolean, errorMessage?: string): string {
    // Late finals must not insert an evicted run and displace a live stream.
    const state = this.runs.get(runId) ?? this.createRunState();
    const streamedContentText = state.contentText;
    this.updateRunState(state, message, showThinking);
    const responseText = resolveFinalAssistantText({
      finalText: state.contentText,
      streamedText: streamedContentText,
      errorMessage,
      message,
    });
    // Thinking is optional presentation around the selected response content;
    // it must not hide errors or attachments when the final has no text.
    const omitEmptyPlaceholder = responseText === "(no output)" && Boolean(state.thinkingText);
    const finalText = composeThinkingAndContent({
      thinkingText: state.thinkingText,
      contentText: omitEmptyPlaceholder ? "" : responseText,
      showThinking,
    });

    this.runs.delete(runId);
    return finalText || "(no output)";
  }

  /** Drops stored stream state for an aborted or discarded run. */
  drop(runId: string) {
    this.runs.delete(runId);
  }

  /** Clears stream fragments when the selected conversation changes. */
  clear() {
    this.runs.clear();
  }
}
