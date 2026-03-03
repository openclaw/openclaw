import {
  composeThinkingAndContent,
  extractContentFromMessage,
  extractThinkingFromMessage,
  resolveFinalAssistantText,
} from "./tui-formatters.js";

type RunStreamState = {
  thinkingText: string;
  contentText: string;
  contentBlocks: string[];
  sawNonTextContentBlocks: boolean;
  postBoundaryContinuationStart: number | null;
  displayText: string;
};

type BoundaryDropMode = "off" | "streamed-only" | "streamed-or-incoming";

function extractTextBlocksAndSignals(message: unknown): {
  textBlocks: string[];
  sawNonTextContentBlocks: boolean;
} {
  if (!message || typeof message !== "object") {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }
  const record = message as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") {
    const text = content.trim();
    return {
      textBlocks: text ? [text] : [],
      sawNonTextContentBlocks: false,
    };
  }
  if (!Array.isArray(content)) {
    return { textBlocks: [], sawNonTextContentBlocks: false };
  }

  const textBlocks: string[] = [];
  let sawNonTextContentBlocks = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") {
      const text = rec.text.trim();
      if (text) {
        textBlocks.push(text);
      }
      continue;
    }
    if (typeof rec.type === "string" && rec.type !== "thinking") {
      sawNonTextContentBlocks = true;
    }
  }
  return { textBlocks, sawNonTextContentBlocks };
}

function isDroppedBoundaryTextBlockSubset(params: {
  streamedTextBlocks: string[];
  finalTextBlocks: string[];
}): boolean {
  const { streamedTextBlocks, finalTextBlocks } = params;
  if (finalTextBlocks.length === 0 || finalTextBlocks.length >= streamedTextBlocks.length) {
    return false;
  }

  const prefixMatches = finalTextBlocks.every(
    (block, index) => streamedTextBlocks[index] === block,
  );
  if (prefixMatches) {
    return true;
  }

  const suffixStart = streamedTextBlocks.length - finalTextBlocks.length;
  return finalTextBlocks.every((block, index) => streamedTextBlocks[suffixStart + index] === block);
}

function shouldPreserveBoundaryDroppedText(params: {
  boundaryDropMode: BoundaryDropMode;
  streamedSawNonTextContentBlocks: boolean;
  incomingSawNonTextContentBlocks: boolean;
  streamedTextBlocks: string[];
  nextContentBlocks: string[];
}) {
  if (params.boundaryDropMode === "off") {
    return false;
  }
  const sawEligibleNonTextContent =
    params.boundaryDropMode === "streamed-or-incoming"
      ? params.streamedSawNonTextContentBlocks || params.incomingSawNonTextContentBlocks
      : params.streamedSawNonTextContentBlocks;
  if (!sawEligibleNonTextContent) {
    return false;
  }
  return isDroppedBoundaryTextBlockSubset({
    streamedTextBlocks: params.streamedTextBlocks,
    finalTextBlocks: params.nextContentBlocks,
  });
}

function shouldAppendPostBoundaryContinuation(params: {
  boundaryDropMode: BoundaryDropMode;
  streamedSawNonTextContentBlocks: boolean;
  incomingSawNonTextContentBlocks: boolean;
  streamedTextBlocks: string[];
  nextContentBlocks: string[];
}) {
  if (params.boundaryDropMode !== "streamed-or-incoming") {
    return false;
  }
  if (!params.streamedSawNonTextContentBlocks && !params.incomingSawNonTextContentBlocks) {
    return false;
  }
  if (params.streamedTextBlocks.length === 0 || params.nextContentBlocks.length === 0) {
    return false;
  }
  return params.nextContentBlocks.every((block) => !params.streamedTextBlocks.includes(block));
}

function isSnapshotCompatibleContinuation(params: {
  previousBlocks: string[];
  nextBlocks: string[];
}): boolean {
  if (params.previousBlocks.length === 0 || params.nextBlocks.length === 0) {
    return false;
  }
  if (params.previousBlocks.length !== params.nextBlocks.length) {
    return false;
  }
  return params.nextBlocks.every((block, index) => {
    const previous = params.previousBlocks[index] ?? "";
    return block === previous || block.startsWith(previous) || previous.startsWith(block);
  });
}

function mergeContinuationWithOverlap(params: {
  previousBlocks: string[];
  nextBlocks: string[];
}): string[] | null {
  const { previousBlocks, nextBlocks } = params;
  if (previousBlocks.length === 0 || nextBlocks.length === 0) {
    return null;
  }
  const maxOverlap = Math.min(previousBlocks.length, nextBlocks.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousSlice = previousBlocks.slice(previousBlocks.length - overlap);
    const nextSlice = nextBlocks.slice(0, overlap);
    const matches = previousSlice.every((block, index) => block === nextSlice[index]);
    if (!matches) {
      continue;
    }
    return [...previousBlocks, ...nextBlocks.slice(overlap)];
  }
  return null;
}

export class TuiStreamAssembler {
  private runs = new Map<string, RunStreamState>();

  private getOrCreateRun(runId: string): RunStreamState {
    let state = this.runs.get(runId);
    if (!state) {
      state = {
        thinkingText: "",
        contentText: "",
        contentBlocks: [],
        sawNonTextContentBlocks: false,
        postBoundaryContinuationStart: null,
        displayText: "",
      };
      this.runs.set(runId, state);
    }
    return state;
  }

  private updateRunState(
    state: RunStreamState,
    message: unknown,
    showThinking: boolean,
    opts?: { boundaryDropMode?: BoundaryDropMode },
  ) {
    const thinkingText = extractThinkingFromMessage(message);
    const contentText = extractContentFromMessage(message);
    const { textBlocks, sawNonTextContentBlocks } = extractTextBlocksAndSignals(message);

    if (thinkingText) {
      state.thinkingText = thinkingText;
    }
    if (contentText) {
      const nextContentBlocks = textBlocks.length > 0 ? textBlocks : [contentText];
      const boundaryDropMode = opts?.boundaryDropMode ?? "off";
      const shouldKeepStreamedBoundaryText = shouldPreserveBoundaryDroppedText({
        boundaryDropMode,
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
        nextContentBlocks,
      });
      const shouldAppendContinuation = shouldAppendPostBoundaryContinuation({
        boundaryDropMode,
        streamedSawNonTextContentBlocks: state.sawNonTextContentBlocks,
        incomingSawNonTextContentBlocks: sawNonTextContentBlocks,
        streamedTextBlocks: state.contentBlocks,
        nextContentBlocks,
      });
      const continuationStart = state.postBoundaryContinuationStart;
      const overlapMergedContinuation =
        continuationStart != null &&
        continuationStart >= 0 &&
        continuationStart <= state.contentBlocks.length
          ? mergeContinuationWithOverlap({
              previousBlocks: state.contentBlocks.slice(continuationStart),
              nextBlocks: nextContentBlocks,
            })
          : null;

      if (overlapMergedContinuation && continuationStart != null) {
        state.contentBlocks = [
          ...state.contentBlocks.slice(0, continuationStart),
          ...overlapMergedContinuation,
        ];
        state.contentText = state.contentBlocks.join("\n");
      } else if (shouldAppendContinuation) {
        const canReplacePriorContinuation =
          continuationStart != null &&
          continuationStart >= 0 &&
          continuationStart <= state.contentBlocks.length &&
          isSnapshotCompatibleContinuation({
            previousBlocks: state.contentBlocks.slice(continuationStart),
            nextBlocks: nextContentBlocks,
          });
        if (canReplacePriorContinuation && continuationStart != null) {
          state.contentBlocks = [
            ...state.contentBlocks.slice(0, continuationStart),
            ...nextContentBlocks,
          ];
        } else {
          state.postBoundaryContinuationStart = state.contentBlocks.length;
          state.contentBlocks = [...state.contentBlocks, ...nextContentBlocks];
        }
        state.contentText = state.contentBlocks.join("\n");
      } else if (!shouldKeepStreamedBoundaryText) {
        state.contentText = contentText;
        state.contentBlocks = nextContentBlocks;
        state.postBoundaryContinuationStart = null;
      }
    }
    if (sawNonTextContentBlocks) {
      state.sawNonTextContentBlocks = true;
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
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-or-incoming",
    });

    if (!state.displayText || state.displayText === previousDisplayText) {
      return null;
    }

    return state.displayText;
  }

  finalize(runId: string, message: unknown, showThinking: boolean): string {
    const state = this.getOrCreateRun(runId);
    const streamedDisplayText = state.displayText;
    const streamedTextBlocks = [...state.contentBlocks];
    const streamedSawNonTextContentBlocks = state.sawNonTextContentBlocks;
    this.updateRunState(state, message, showThinking, {
      boundaryDropMode: "streamed-only",
    });
    const finalComposed = state.displayText;
    const shouldKeepStreamedText =
      streamedSawNonTextContentBlocks &&
      isDroppedBoundaryTextBlockSubset({
        streamedTextBlocks,
        finalTextBlocks: state.contentBlocks,
      });
    const finalText = resolveFinalAssistantText({
      finalText: shouldKeepStreamedText ? streamedDisplayText : finalComposed,
      streamedText: streamedDisplayText,
    });

    this.runs.delete(runId);
    return finalText;
  }

  drop(runId: string) {
    this.runs.delete(runId);
  }
}
