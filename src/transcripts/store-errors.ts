export class TranscriptsSummaryChangedError extends Error {
  constructor() {
    super("Transcript changed while generating notes; summarize it again.");
  }
}

export class TranscriptSessionAmbiguousError extends Error {
  readonly selectors: readonly string[];

  constructor(query: string, selectors: readonly string[]) {
    super(`multiple transcripts sessions match ${query}; use one of: ${selectors.join(", ")}`);
    this.selectors = selectors;
  }
}

export class TranscriptSessionConflictError extends Error {
  constructor() {
    super("Transcript session ID conflicts with another capture on this date; use a new ID.");
    this.name = "TranscriptSessionConflictError";
  }
}
