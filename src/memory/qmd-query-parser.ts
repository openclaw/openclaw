import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory");
const ANSI_CSI_RE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_OSC_RE = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, "g");
const NO_RESULTS_LINE_RE = /^no results found(?: above minimum score threshold)?\.?$/i;

export type QmdQueryResult = {
  docid?: string;
  score?: number;
  file?: string;
  snippet?: string;
  body?: string;
};

export function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const normalizedStdout = normalizeQmdOutput(stdout);
  const normalizedStderr = normalizeQmdOutput(stderr);
  const stdoutHasNoResults = containsNoResultsMarker(normalizedStdout);
  const stderrHasNoResults = containsNoResultsMarker(normalizedStderr);
  const jsonPayload = extractJsonArray(normalizedStdout) ?? extractJsonArray(normalizedStderr);

  if (!jsonPayload) {
    if (stdoutHasNoResults || (!normalizedStdout.trim() && stderrHasNoResults)) {
      return [];
    }
    if (stderrHasNoResults) {
      return [];
    }
  }

  if (!jsonPayload) {
    const context = normalizedStderr.trim()
      ? ` (stderr: ${summarizeQmdStderr(normalizedStderr.trim())})`
      : "";
    const message = `stdout did not contain JSON array${context}`;
    log.warn(`qmd query returned invalid JSON: ${message}`);
    throw new Error(`qmd query returned invalid JSON: ${message}`);
  }

  try {
    const parsed = JSON.parse(jsonPayload) as unknown;
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

function normalizeQmdOutput(raw: string): string {
  if (!raw) {
    return "";
  }
  return raw.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "").replace(/\r/g, "");
}

function containsNoResultsMarker(raw: string): boolean {
  if (!raw.trim()) {
    return false;
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const normalized = line.toLowerCase().replace(/\s+/g, " ");
    if (NO_RESULTS_LINE_RE.test(normalized)) {
      return true;
    }
  }
  return false;
}

function extractJsonArray(raw: string): string | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "[") {
      continue;
    }
    const candidate = extractBalancedArray(text, i);
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        return candidate;
      }
    } catch {
      // keep scanning for the next potential payload
    }
  }
  return null;
}

function extractBalancedArray(raw: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let idx = startIdx; idx < raw.length; idx += 1) {
    const ch = raw[idx];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      depth += 1;
      continue;
    }
    if (ch !== "]") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return raw.slice(startIdx, idx + 1);
    }
    if (depth < 0) {
      return null;
    }
  }
  return null;
}

function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
}
