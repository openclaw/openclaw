// Classification of outbound messages by user-visible meaning.
//
// `MessageClass` replaces the legacy boolean `trusted` flag with a closed
// discriminated union so the delivery policy can branch on explicit semantics
// instead of freeform strings or ambiguous booleans.
//
// The classifier itself is a pure function. Every branch of ClassificationSignal
// is expected to return a concrete class; the safe default across every
// unknown/unclassifiable shape is "internal_narration" so new surfaces never
// silently leak progress chatter to user-facing channels.

export type MessageClass =
  | "final_reply"
  | "progress"
  | "completion"
  | "internal_narration"
  | "resume"
  | "boot"
  | "blocked";

export type ClassificationSignal =
  | {
      source: "acp_stream";
      stream: string;
      tag?: string;
      text?: string;
    }
  | {
      source: "codex_event";
      eventType: string;
      itemType?: string;
      text?: string;
    }
  | {
      source: "boot_session";
      sessionKey: string;
      text?: string;
    }
  | {
      source: "task_terminal";
      text: string;
      terminal: "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "blocked";
    }
  | {
      source: "task_progress";
      text: string;
    }
  | {
      source: "heartbeat_drain";
      originalClass?: MessageClass;
      text?: string;
    }
  | {
      source: "unclassified";
      text: string;
    };

// Well-known ACP streams that are user-visible. Anything else defaults to
// internal_narration to prevent new streams from silently surfacing.
const USER_VISIBLE_ACP_STREAMS = new Set<string>(["assistant", "lifecycle"]);

// Boot-session key prefix. Any sessionKey that starts with these prefixes is
// treated as a boot/resume operator signal, not a user-facing message.
export const BOOT_SESSION_KEY_PREFIXES = ["boot-", "boot:"] as const;

// Patterns that indicate the message represents an agent asking the user for
// input ("blocked" in the Blocked-Child Protocol sense). Detection is
// intentionally conservative — classifying too little as blocked is safe (the
// main surface will still see it as a `final_reply`), but classifying too much
// as blocked risks re-delivering noise. Keep these heuristics small and
// auditable.
const BLOCKED_HEURISTICS: ReadonlyArray<RegExp> = [
  /\bi['’]m blocked\b/i,
  /\bi am blocked\b/i,
  /\bshould i\b[^.?!]*\?/i,
  /\bneed (?:your )?(?:input|guidance|decision)\b/i,
  /\bwaiting (?:on|for) (?:you|input|approval)\b/i,
];

function detectBlocked(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  for (const pattern of BLOCKED_HEURISTICS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

export function isBootSessionKey(sessionKey: string): boolean {
  for (const prefix of BOOT_SESSION_KEY_PREFIXES) {
    if (sessionKey.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function classifyMessageClass(signal: ClassificationSignal): MessageClass {
  switch (signal.source) {
    case "boot_session": {
      // Boot-key prefixes are the authoritative signal; if someone called us
      // with source="boot_session" but the key is not actually a boot key, be
      // safe and treat as internal_narration.
      if (isBootSessionKey(signal.sessionKey)) {
        return "boot";
      }
      return "internal_narration";
    }
    case "acp_stream": {
      // Block-check before normal routing: agents sometimes signal blocked
      // status via the assistant stream.
      if (detectBlocked(signal.text)) {
        return "blocked";
      }
      if (USER_VISIBLE_ACP_STREAMS.has(signal.stream)) {
        // `assistant` without further qualifiers is the final assistant turn
        // body. `lifecycle` is a progress-class signal (started/ended).
        if (signal.stream === "assistant") {
          return "final_reply";
        }
        return "progress";
      }
      // UNKNOWN stream: safe default — never surface it to a user channel.
      return "internal_narration";
    }
    case "codex_event": {
      if (signal.eventType === "codex_app_server.item" && signal.itemType === "assistant_message") {
        // Provisional final_reply. The caller must verify turn-phase (e.g.
        // ensure the agent has reached its terminal message before surfacing).
        if (detectBlocked(signal.text)) {
          return "blocked";
        }
        return "final_reply";
      }
      // All other codex events (tool_call, reasoning, session lifecycle, …)
      // are internal narration unless specifically promoted elsewhere.
      return "internal_narration";
    }
    case "task_terminal": {
      if (signal.terminal === "blocked") {
        return "blocked";
      }
      return "completion";
    }
    case "task_progress": {
      if (detectBlocked(signal.text)) {
        return "blocked";
      }
      return "progress";
    }
    case "heartbeat_drain": {
      // Heartbeat drain re-delivers already-classified events. Preserve the
      // original class if supplied; otherwise treat as internal narration
      // (safe default; blocked events MUST already have been classified).
      return signal.originalClass ?? "internal_narration";
    }
    case "unclassified": {
      if (detectBlocked(signal.text)) {
        return "blocked";
      }
      return "internal_narration";
    }
    default: {
      // Exhaustiveness guard: TypeScript narrows signal to `never` here. If a
      // new source is added to ClassificationSignal without a classifier case,
      // the assignment below fails at compile time. The runtime fallback keeps
      // ambient safety at parity with the safe default ("internal_narration").
      const _exhaustive: never = signal;
      void _exhaustive;
      return "internal_narration";
    }
  }
}
