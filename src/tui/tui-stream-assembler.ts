import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

type RunStreamState = {
  thinkingText: string;
  contentText: string;
  displayText: string;
};

export class TuiStreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreateRun(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        thinkingText: "",
        contentText: "",
        displayText: "",
      };
      this.runs.set(runId, state);
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

  ingestDelta(runId: string, message: unknown, showThinking: boolean): string | null {
    const state = this.getOrCreateRun(runId);
    const previousDisplayText = state.displayText;
    this.updateRunState(state, message, showThinking);

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  finalize(runId: string, message: unknown, showThinking: boolean): string {
    const state = this.getOrCreateRun(runId);
    this.updateRunState(state, message, showThinking);
    const finalComposed = state.displayText;
    const finalText = resolveFinalAssistantText({
      finalText: finalComposed,
      streamedText: state.displayText,
    });

    this.runs.delete(runId);
    return finalText;
  }

  drop(runId: string) {
    this.runs.delete(runId);
  }
}
