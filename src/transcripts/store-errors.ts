export class TranscriptsSummaryChangedError extends Error {
  constructor() {
    super("Transcript changed while generating notes; summarize it again.");
  }
}

export class TranscriptSessionConflictError extends Error {
  constructor() {
    super("Transcript session ID conflicts with another capture on this date; use a new ID.");
    this.name = "TranscriptSessionConflictError";
  }
}
