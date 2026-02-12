import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

export type QmdQueryResult = {
  docid?: string;
  score?: number;
  file?: string;
  snippet?: string;
  body?: string;
};

export function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  const stdoutIsMarker = trimmedStdout.length > 0 && isQmdNoResultsOutput(trimmedStdout);
  const stderrIsMarker = trimmedStderr.length > 0 && isQmdNoResultsOutput(trimmedStderr);
  if (stdoutIsMarker || (!trimmedStdout && stderrIsMarker)) {
    return [];
  }
  if (!trimmedStdout) {
    const context = trimmedStderr ? ` (stderr: ${summarizeQmdStderr(trimmedStderr)})` : "";
    const message = `stdout empty${context}`;
    log.warn(`qmd query returned invalid JSON: ${message}`);
    throw new Error(`qmd query returned invalid JSON: ${message}`);
  }
  try {
    const parsed = JSON.parse(trimmedStdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("qmd query JSON response was not an array");
    }
    return parsed as QmdQueryResult[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`qmd query returned invalid JSON: ${message}`);
    throw new Error(`qmd query returned invalid JSON: ${message}`, { cause: err });
  }
}

function isQmdNoResultsOutput(raw: string): boolean {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "no results found" || normalized === "no results found.";
}

function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}
