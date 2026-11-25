export function positiveDurationError(label: string, unit: "ms" | "s"): Error {
  const examples = unit === "ms" ? "500ms, 10s, 1m" : "1, 2.5, 10";
  return new Error(
    `${label} must be a positive duration (1–${Number.MAX_SAFE_INTEGER}${unit} after rounding; e.g. ${examples}).`,
  );
}
