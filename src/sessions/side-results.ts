import fs from "node:fs";
import path from "node:path";

export const SESSION_SIDE_RESULTS_SUFFIX = ".side-results.jsonl";

export type PersistedSessionSideResult = {
  kind: "btw";
  question: string;
  text: string;
  ts: number;
  isError?: boolean;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  reasoningLevel?: string;
  sessionKey?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  usage?: unknown;
};

export function resolveSessionSideResultsPathFromTranscript(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath.trim());
  return resolved.endsWith(".jsonl")
    ? `${resolved.slice(0, -".jsonl".length)}${SESSION_SIDE_RESULTS_SUFFIX}`
    : `${resolved}${SESSION_SIDE_RESULTS_SUFFIX}`;
}

export function appendSessionSideResult(params: {
  transcriptPath: string;
  result: PersistedSessionSideResult;
}) {
  const filePath = resolveSessionSideResultsPathFromTranscript(params.transcriptPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(params.result)}\n`, "utf-8");
  return filePath;
}
