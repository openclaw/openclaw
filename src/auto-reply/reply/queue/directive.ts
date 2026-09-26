import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Converts queue directives into normalized queue settings.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import {
  removeDirectiveSpan,
  skipDirectiveArgPrefix,
  takeDirectiveToken,
} from "../directive-parsing.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import type { QueueDropPolicy } from "./types.js";

/** Parses debounce durations in `/queue` directives. */
function parseQueueDebounce(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = parseDurationMs(raw.trim(), { defaultUnit: "ms" });
    if (!parsed || parsed < 0) {
      return undefined;
    }
    return Math.round(parsed);
  } catch {
    return undefined;
  }
}

function parseQueueDirectiveArgs(raw: string): {
  consumed: number;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasOptions: boolean;
} {
  let i = skipDirectiveArgPrefix(raw);
  const argsStart = i;
  let consumed = i;
  let queueMode: QueueMode | undefined;
  let queueReset = false;
  let rawMode: string | undefined;
  let debounceMs: number | undefined;
  let cap: number | undefined;
  let dropPolicy: QueueDropPolicy | undefined;
  let rawDebounce: string | undefined;
  let rawCap: string | undefined;
  let rawDrop: string | undefined;
  let hasOptions = false;
  while (i < raw.length) {
    const { token, nextIndex } = takeDirectiveToken(raw, i);
    i = nextIndex;
    if (!token) {
      break;
    }
    const lowered = normalizeOptionalLowercaseString(token);
    if (!lowered) {
      break;
    }
    if (lowered === "default" || lowered === "reset" || lowered === "clear") {
      queueReset = true;
      consumed = i;
      break;
    }
    if (lowered.startsWith("debounce:") || lowered.startsWith("debounce=")) {
      rawDebounce = token.split(/[:=]/)[1] ?? "";
      debounceMs = parseQueueDebounce(rawDebounce);
      hasOptions = true;
      consumed = i;
      continue;
    }
    if (lowered.startsWith("cap:") || lowered.startsWith("cap=")) {
      rawCap = token.split(/[:=]/)[1] ?? "";
      cap = parseStrictPositiveInteger(rawCap);
      hasOptions = true;
      consumed = i;
      continue;
    }
    if (lowered.startsWith("drop:") || lowered.startsWith("drop=")) {
      rawDrop = token.split(/[:=]/)[1] ?? "";
      dropPolicy = normalizeQueueDropPolicy(rawDrop);
      hasOptions = true;
      consumed = i;
      continue;
    }
    const mode = normalizeQueueMode(token);
    if (mode) {
      queueMode = mode;
      rawMode = token;
      consumed = i;
      continue;
    }
    if (consumed === argsStart && !queueReset && !hasOptions) {
      rawMode = token;
      consumed = i;
    }
    // Stop at first unrecognized token.
    break;
  }
  return {
    consumed,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasOptions,
  };
}

/** Extracts and removes a `/queue` directive from message text. */
export function extractQueueDirective(rawBody?: string): Omit<
  ReturnType<typeof parseQueueDirectiveArgs>,
  "consumed"
> & {
  cleaned: string;
  hasDirective: boolean;
} {
  const body = rawBody ?? "";
  const re = /(?<!\S)\/queue(?=$|\s|:)/i;
  const match = re.exec(body);
  if (!match) {
    return {
      cleaned: body,
      hasDirective: false,
      queueReset: false,
      hasOptions: false,
    };
  }
  const start = match.index;
  const argsStart = start + "/queue".length;
  const args = body.slice(argsStart);
  const { consumed, ...parsed } = parseQueueDirectiveArgs(args);
  // Remove only the directive and consumed options; leave the rest as agent input.
  const cleaned = removeDirectiveSpan(body, start, argsStart + consumed);
  return {
    cleaned,
    ...parsed,
    hasDirective: true,
  };
}
