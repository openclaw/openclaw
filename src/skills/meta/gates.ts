export type MetaGateResult = {
  name: string;
  result: "passed" | "failed" | "skipped";
};

export function summarizeMetaGateResults(results: MetaGateResult[]): {
  result: "passed" | "failed";
  evidence: string;
} {
  const failed = results.some((entry) => entry.result === "failed");
  return {
    result: failed ? "failed" : "passed",
    evidence: results.map((entry) => `${entry.name}: ${entry.result}`).join("\n"),
  };
}
