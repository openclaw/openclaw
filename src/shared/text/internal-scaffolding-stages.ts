const names = [
  "reasoning",
  "modelTokens",
  "memories",
  "xml",
  "trace",
  "legacy",
  "plain",
  "leading",
  "invisible",
] as const;

/** The internal-scaffolding profile has one order for batch and streaming callers. */
export function orderInternalScaffoldingStages<T>(stages: Record<(typeof names)[number], T>): T[] {
  return names.map((name) => stages[name]);
}
