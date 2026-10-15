import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { parseDurationMs } from "../../../cli/parse-duration.js";
import {
  removeDirectiveSpan,
  skipDirectiveArgPrefix,
  takeDirectiveToken,
} from "../directive-parsing.js";
import { normalizeQueueDropPolicy, normalizeQueueMode } from "./normalize.js";
import type { QueueDropPolicy } from "./types.js";

function parseQueueDebounce(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = parseDurationMs(raw.trim(), { defaultUnit: "ms" });
    return parsed > 0 ? Math.round(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/** Extracts and removes a `/queue` directive from message text. */
export function extractQueueDirective(rawBody?: string): {
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
  cleaned: string;
  hasDirective: boolean;
} {
  const body = rawBody ?? "";
  const match = /(?<!\S)\/queue(?=$|\s|:)/i.exec(body);
  if (!match) {
    return {
      cleaned: body,
      hasDirective: false,
      queueReset: false,
      hasOptions: false,
    };
  }
  const argsStart = match.index + "/queue".length;
  const raw = body.slice(argsStart);
  let i = skipDirectiveArgPrefix(raw);
  const firstToken = i;
  let consumed = i;
  const parsed: ReturnType<typeof extractQueueDirective> = {
    cleaned: body,
    hasDirective: true,
    queueMode: undefined,
    queueReset: false,
    rawMode: undefined,
    debounceMs: undefined,
    cap: undefined,
    dropPolicy: undefined,
    rawDebounce: undefined,
    rawCap: undefined,
    rawDrop: undefined,
    hasOptions: false,
  };
  while (i < raw.length) {
    const { token, nextIndex } = takeDirectiveToken(raw, i);
    i = nextIndex;
    if (!token) {
      break;
    }
    const lowered = token.toLowerCase();
    if (lowered === "default" || lowered === "reset" || lowered === "clear") {
      parsed.queueReset = true;
      consumed = i;
      break;
    }
    if (lowered.startsWith("debounce:") || lowered.startsWith("debounce=")) {
      parsed.rawDebounce = token.split(/[:=]/)[1] ?? "";
      parsed.debounceMs = parseQueueDebounce(parsed.rawDebounce);
    } else if (lowered.startsWith("cap:") || lowered.startsWith("cap=")) {
      parsed.rawCap = token.split(/[:=]/)[1] ?? "";
      parsed.cap = parseStrictPositiveInteger(parsed.rawCap);
    } else if (lowered.startsWith("drop:") || lowered.startsWith("drop=")) {
      parsed.rawDrop = token.split(/[:=]/)[1] ?? "";
      parsed.dropPolicy = normalizeQueueDropPolicy(parsed.rawDrop);
    } else {
      const mode = normalizeQueueMode(token);
      if (mode) {
        parsed.queueMode = mode;
        parsed.rawMode = token;
        consumed = i;
        continue;
      }
      if (consumed === firstToken && !parsed.queueReset && !parsed.hasOptions) {
        parsed.rawMode = token;
        consumed = i;
      }
      break;
    }
    parsed.hasOptions = true;
    consumed = i;
  }
  // Remove only the directive and consumed options; leave the rest as agent input.
  parsed.cleaned = removeDirectiveSpan(body, match.index, argsStart + consumed);
  return parsed;
}
