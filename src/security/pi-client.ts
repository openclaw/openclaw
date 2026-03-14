/**
 * Prompt Inspector client for prompt injection detection.
 *
 * Provides a lightweight, fail-open HTTP client that calls the Prompt Inspector
 * detection API (https://promptinspector.io) to check whether incoming text
 * content contains prompt injection attempts.
 *
 * Configuration is read from environment variables (set them directly or load
 * them from ~/.openclaw/.env via loadOpenClawDotEnv() at startup):
 *
 *   PMTINSP_API_KEY   – (required) API key from promptinspector.io
 *   PMTINSP_BASE_URL  – (optional) override API base URL, e.g. for self-hosted
 *   PMTINSP_TIMEOUT   – (optional) request timeout in seconds (default: 5)
 *   PMTINSP_ENABLED   – (optional) set to "false" to globally disable detection
 *   PMTINSP_ON_UNSAFE – (optional) "log" (default) | "warn" | "block"
 *                         log   → only write a warning log entry
 *                         warn  → log + append a safety notice to the content
 *                         block → log + throw an error to reject the message
 */

import * as http from "node:http";
import * as https from "node:https";

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("pi-detect");

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://promptinspector.io";
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Maximum number of characters sampled from content for a single detection
 * request. Prompt injection markers almost always appear near the start of
 * malicious content, so sampling the first 8000 chars is sufficient while
 * keeping API costs low.
 */
const MAX_DETECT_CHARS = 8_000;

/**
 * Tool names whose results arrive from external / web sources and therefore
 * require prompt injection scanning.
 */
export const WEB_TOOL_NAMES = new Set([
  "web_fetch",
  "web_search",
  "browser",
  "fetch",
  "browse",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

/** Raw JSON shape returned by the Prompt Inspector detection endpoint. */
type PiApiResponse = {
  request_id: string;
  result: {
    is_safe: boolean;
    score: number | null;
    category: string[];
  };
  latency_ms: number;
};

/** Possible outcomes of a detectSafety() call. */
export type PiDetectionResult =
  | {
      checked: true;
      safe: boolean;
      score: number | null;
      category: string[];
      latencyMs: number;
    }
  | {
      checked: false;
      /** Why detection was skipped or failed. */
      reason: "disabled" | "no-key" | "empty" | "error";
    };

// ─── Module-level state (lazy-initialized) ───────────────────────────────────

let initialized = false;
let enabled = true;
let apiKey: string | null = null;
let baseUrl = DEFAULT_BASE_URL;
let timeoutMs = DEFAULT_TIMEOUT_MS;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the Prompt Inspector client from environment variables.
 * Idempotent – safe to call multiple times; only the first call takes effect.
 * Must be called after environment variables are loaded (e.g. after
 * loadOpenClawDotEnv() runs in normalizeEnv()).
 */
export function initPiClient(): void {
  if (initialized) return;
  initialized = true;

  if (process.env.PMTINSP_ENABLED === "false") {
    enabled = false;
    log.debug("prompt-injection detection disabled via PMTINSP_ENABLED=false");
    return;
  }

  const key = process.env.PMTINSP_API_KEY?.trim();
  if (!key) {
    // No key – detection silently unavailable; no warning spam on every startup.
    return;
  }

  apiKey = key;
  baseUrl = (process.env.PMTINSP_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");

  const rawTimeout = parseInt(process.env.PMTINSP_TIMEOUT ?? "", 10);
  if (Number.isFinite(rawTimeout) && rawTimeout > 0) {
    timeoutMs = rawTimeout * 1_000;
  }

  log.info(
    `prompt-injection detection enabled: endpoint=${baseUrl}/api/v1/detect/sdk timeout=${timeoutMs}ms`,
  );
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function sendDetectRequest(text: string): Promise<PiApiResponse> {
  return new Promise<PiApiResponse>((resolve, reject) => {
    const body = JSON.stringify({ input_text: text });
    const endpoint = new URL(`${baseUrl}/api/v1/detect/sdk`);
    const isHttps = endpoint.protocol === "https:";
    // Use https or http transport depending on the URL scheme.
    const transport = isHttps ? https : (http as unknown as typeof https);

    const req = transport.request(
      {
        method: "POST",
        hostname: endpoint.hostname,
        port: endpoint.port || (isHttps ? 443 : 80),
        path: endpoint.pathname,
        headers: {
          "Content-Type": "application/json",
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          "X-App-Key": apiKey!,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          const rawBody = Buffer.concat(chunks).toString("utf-8");
          // Reject with a descriptive message for non-2xx responses so that
          // API key or rate-limit issues are clearly visible in debug logs.
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `Prompt Inspector returned HTTP ${statusCode}: ${rawBody.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(rawBody) as PiApiResponse;
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse Prompt Inspector response: ${String(err)}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Prompt Inspector request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err: Error) => {
      reject(new Error(`Prompt Inspector request error: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect potential prompt injection in the given text.
 *
 * This function is designed to be **fail-open**: any error during detection
 * (network failure, timeout, missing API key, etc.) returns
 * `{ checked: false }` rather than throwing.  The caller decides whether to
 * act on the result; the default behaviour is to log and continue.
 *
 * @param text    - Content to analyse. Truncated to MAX_DETECT_CHARS internally.
 * @param context - Optional label included in log messages (e.g. "hook/agent",
 *                  "web_fetch") to help with operational tracing.
 */
export async function detectSafety(
  text: string,
  context?: string,
): Promise<PiDetectionResult> {
  // Ensure client is initialized (picks up env vars loaded after module import).
  if (!initialized) initPiClient();

  if (!enabled) return { checked: false, reason: "disabled" };
  if (!apiKey) return { checked: false, reason: "no-key" };

  const sample = text.length > MAX_DETECT_CHARS ? text.slice(0, MAX_DETECT_CHARS) : text;
  if (!sample.trim()) return { checked: false, reason: "empty" };

  try {
    const resp = await sendDetectRequest(sample);
    const result: PiDetectionResult = {
      checked: true,
      safe: resp.result.is_safe,
      score: resp.result.score ?? null,
      category: resp.result.category ?? [],
      latencyMs: resp.latency_ms ?? 0,
    };

    if (!result.safe) {
      const label = context ? ` [${context}]` : "";
      log.warn(
        `prompt injection detected${label}: score=${result.score ?? "n/a"} ` +
          `category=${result.category.join(",") || "unknown"} latency=${result.latencyMs}ms`,
      );
    }

    return result;
  } catch (err) {
    // Fail-open: detection errors must never block legitimate traffic.
    const label = context ? ` [${context}]` : "";
    log.debug(`prompt injection check failed${label} (fail-open): ${String(err)}`);
    return { checked: false, reason: "error" };
  }
}

/** Discriminated-union branch for a completed (checked) detection result. */
export type CheckedDetectionResult = Extract<PiDetectionResult, { checked: true }>;

/**
 * Returns true if the detection result conclusively identified unsafe content.
 * Returns false for all unchecked/error cases (fail-open semantics).
 *
 * Declared as a type predicate so TypeScript narrows `result` to
 * `CheckedDetectionResult` inside the truthy branch, giving callers
 * safe access to `.score`, `.category`, and `.latencyMs`.
 */
export function isUnsafe(result: PiDetectionResult): result is CheckedDetectionResult {
  return result.checked && !result.safe;
}

/**
 * Returns the configured PMTINSP_ON_UNSAFE policy.
 *   "log"   – only write a warning (default)
 *   "warn"  – log + caller should append a safety notice
 *   "block" – log + caller should reject the message with an error
 */
export function getOnUnsafePolicy(): "log" | "warn" | "block" {
  const raw = process.env.PMTINSP_ON_UNSAFE?.trim().toLowerCase();
  if (raw === "warn") return "warn";
  if (raw === "block") return "block";
  return "log";
}
