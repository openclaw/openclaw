export type TextProjection = { text: string; delta: string | null };
export type TextProjectionUpdate = TextProjection & {
  // Producer-owned unchanged prefix, ending in non-whitespace, and mutable tail.
  retained?: { prefix: string; tail: string };
};
export type TextProjector = ((input: TextProjectionUpdate) => TextProjectionUpdate) & {
  canReplaceFrom?: (start: number) => boolean;
};
