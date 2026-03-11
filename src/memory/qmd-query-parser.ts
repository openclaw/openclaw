import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");

export type QmdQueryResult = {
  docid?: string;
  score?: number;
  collection?: string;
  file?: string;
  snippet?: string;
  body?: string;
};

type JsonRecord = Record<string, unknown>;

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
    const parsed = parseQmdQueryResultArray(trimmedStdout);
    if (parsed !== null) {
      return parsed;
    }
    const noisyPayload = extractFirstJsonArray(trimmedStdout);
    if (!noisyPayload) {
      throw new Error("qmd query JSON response was not an array");
    }
    const fallback = parseQmdQueryResultArray(noisyPayload);
    if (fallback !== null) {
      return fallback;
    }
    throw new Error("qmd query JSON response was not an array");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`qmd query returned invalid JSON: ${message}`);
    throw new Error(`qmd query returned invalid JSON: ${message}`, { cause: err });
  }
}

export function parseQmdMcporterJson(stdout: string, stderr: string): QmdQueryResult[] {
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
    log.warn(`qmd mcporter returned invalid JSON: ${message}`);
    throw new Error(`qmd mcporter returned invalid JSON: ${message}`);
  }
  try {
    const parsed = parseQmdJsonPayload(trimmedStdout);
    if (parsed === null) {
      throw new Error("qmd mcporter JSON response could not be parsed");
    }
    const results = normalizeQmdResultsFromUnknown(parsed);
    if (!results) {
      throw new Error("qmd mcporter JSON response missing results array");
    }
    return results;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`qmd mcporter returned invalid JSON: ${message}`);
    throw new Error(`qmd mcporter returned invalid JSON: ${message}`, { cause: err });
  }
}

function isQmdNoResultsOutput(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  return lines.some((line) => isQmdNoResultsLine(line));
}

function isQmdNoResultsLine(line: string): boolean {
  if (line === "no results found" || line === "no results found.") {
    return true;
  }
  return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|qmd)\s*:\s*)+no results found\.?$/.test(
    line,
  );
}

function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseQmdQueryResultArray(raw: string): QmdQueryResult[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed as QmdQueryResult[];
  } catch {
    return null;
  }
}

function parseQmdJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    const extracted = extractFirstJsonValue(raw);
    if (!extracted) {
      return null;
    }
    try {
      return JSON.parse(extracted) as unknown;
    } catch {
      return null;
    }
  }
}

function normalizeQmdResultsFromUnknown(payload: unknown): QmdQueryResult[] | null {
  let value = payload;
  if (isRecord(value) && "result" in value) {
    value = value.result;
  }
  if (Array.isArray(value)) {
    return normalizeQmdResultArray(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.structuredContent)) {
    value = value.structuredContent;
    if (isRecord(value) && Array.isArray(value.results)) {
      return normalizeQmdResultArray(value.results);
    }
    return null;
  }
  if (Array.isArray(value.results)) {
    return normalizeQmdResultArray(value.results);
  }
  return null;
}

function normalizeQmdResultArray(value: unknown[]): QmdQueryResult[] | null {
  const results: QmdQueryResult[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const docid = normalizeQmdDocId(entry.docid);
    if (!docid) {
      continue;
    }
    const normalized: QmdQueryResult = {
      ...entry,
      docid,
      score: normalizeQmdScore(entry.score),
    };
    if (typeof entry.snippet === "string") {
      normalized.snippet = entry.snippet;
    }
    results.push(normalized);
  }
  return results;
}

function normalizeQmdDocId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/^#/, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeQmdScore(score: unknown): number {
  const value = typeof score === "number" ? score : Number(score);
  return Number.isFinite(value) ? value : 0;
}

function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start < 0) {
    return null;
  }
  return extractJsonValue(raw, start, "[", "]");
}

function extractFirstJsonValue(raw: string): string | null {
  let searchIndex = 0;
  while (searchIndex < raw.length) {
    const arrayStart = raw.indexOf("[", searchIndex);
    const objectStart = raw.indexOf("{", searchIndex);
    if (arrayStart < 0 && objectStart < 0) {
      return null;
    }
    const useObject = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart);
    const start = useObject ? objectStart : arrayStart;
    const open = useObject ? "{" : "[";
    const close = useObject ? "}" : "]";
    const extracted = extractJsonValue(raw, start, open, close);
    if (extracted) {
      try {
        JSON.parse(extracted);
        return extracted;
      } catch {
        // keep searching for the next candidate
      }
    }
    searchIndex = start + 1;
  }
  return null;
}

function extractJsonValue(raw: string, start: number, open: string, close: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}
