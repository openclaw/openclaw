export type CrashRootCause =
  | "rate_limit"
  | "auth_token_invalid"
  | "auth_blocked"
  | "auth_pairing"
  | "auth_resource"
  | "network_dns"
  | "network_timeout"
  | "network_tls"
  | "network_refused"
  | "network_poll_stall"
  | "network_watchdog"
  | "llm_timeout"
  | "config_missing_module"
  | "config_invalid_json"
  | "config_unknown_model"
  | "config_sdk_mismatch"
  | "lifecycle_drain"
  | "lifecycle_launchctl"
  | "lifecycle_stale_pid"
  | "lifecycle_port_conflict"
  | "agent_missing_context"
  | "agent_file_hallucination"
  | "agent_command_missing"
  | "agent_browser"
  | "internal_bug"
  | "unknown";

export type RootCauseResult = {
  cause: CrashRootCause;
  confidence: number; // 0-1
  category:
    | "rate_limit"
    | "auth_failure"
    | "network"
    | "config"
    | "lifecycle"
    | "agent"
    | "internal"
    | "unknown";
  shouldRetry: boolean;
  shouldNotifyOperator: boolean;
  shouldAdjustConfig: boolean;
};

// Build patterns from REAL log data (38 error patterns found in 10 days of production logs):
const ROOT_CAUSE_PATTERNS: Array<[RegExp, CrashRootCause, number]> = [
  // Rate limiting (2,456 real events)
  [/API rate limit|rate.?limit reached|too many req/i, "rate_limit", 0.95],
  [/429/i, "rate_limit", 0.85],
  [/lane wait exceeded|waitedMs/i, "rate_limit", 0.7],

  // Auth failure (2,244 real events)
  [/401.*Unauthorized|failed.*401|401.*failed/i, "auth_token_invalid", 0.95],
  [/身份验证失败|authentication failed/i, "auth_token_invalid", 0.9],
  [/403.*Forbidden|blocked|banned/i, "auth_blocked", 0.9],
  [/pairing required|code=1008/i, "auth_pairing", 0.95],
  [/resource not granted|code.*3001/i, "auth_resource", 0.85],
  [/token.*expired|token.*invalid/i, "auth_token_invalid", 0.9],

  // Network (3,300+ real events)
  [/autoSelectFamily.*false.*ipv4first/i, "network_dns", 0.8],
  [/ENOTFOUND|getaddrinfo.*failed/i, "network_dns", 0.95],
  [/ECONNREFUSED|connection refused/i, "network_refused", 0.95],
  [/ETIMEDOUT|timed? ?out|timeout after \d+ms/i, "network_timeout", 0.85],
  [/TLS.*handshake|secure.*connection/i, "network_tls", 0.9],
  [/Polling stall.*no getUpdates/i, "network_poll_stall", 0.9],
  [/reconnect watchdog timeout/i, "network_watchdog", 0.95],
  [/LLM request timed out/i, "llm_timeout", 0.9],
  [/socket hang up|ECONNRESET/i, "network_timeout", 0.8],
  [/fetch failed|network.*error/i, "network_timeout", 0.7],

  // Config (542 real events)
  [/Cannot find module/i, "config_missing_module", 0.95],
  [/JSON5? parse failed|invalid.*config.*json/i, "config_invalid_json", 0.95],
  [/Unknown model|unknown.*model/i, "config_unknown_model", 0.9],
  [/is not a function|SDK.*mismatch/i, "config_sdk_mismatch", 0.85],

  // Lifecycle (32 real events, highest impact)
  [/GatewayDrainingError|draining for restart/i, "lifecycle_drain", 0.95],
  [/spawnSync launchctl ETIMEDOUT/i, "lifecycle_launchctl", 0.95],
  [/kill-failed.*pid.*not found/i, "lifecycle_stale_pid", 0.9],
  [/address already in use|EADDRINUSE|Errno 48/i, "lifecycle_port_conflict", 0.95],

  // Agent tool misuse (430 real events)
  [/guildId required/i, "agent_missing_context", 0.95],
  [/ENOENT.*no such file/i, "agent_file_hallucination", 0.85],
  [/command not found/i, "agent_command_missing", 0.9],
  [/tab not found|Chrome CDP|Failed to start Chrome/i, "agent_browser", 0.9],

  // Internal bugs
  [/TypeError|ReferenceError|SyntaxError/i, "internal_bug", 0.7],
  [/KeyError|AttributeError/i, "internal_bug", 0.8],
  [/Unhandled.*rejection/i, "internal_bug", 0.75],
  [/write after end/i, "internal_bug", 0.8],
];

const CATEGORY_MAP: Record<string, RootCauseResult["category"]> = {
  rate_limit: "rate_limit",
  auth_token_invalid: "auth_failure",
  auth_blocked: "auth_failure",
  auth_pairing: "auth_failure",
  auth_resource: "auth_failure",
  network_dns: "network",
  network_timeout: "network",
  network_tls: "network",
  network_refused: "network",
  network_poll_stall: "network",
  network_watchdog: "network",
  llm_timeout: "network",
  config_missing_module: "config",
  config_invalid_json: "config",
  config_unknown_model: "config",
  config_sdk_mismatch: "config",
  lifecycle_drain: "lifecycle",
  lifecycle_launchctl: "lifecycle",
  lifecycle_stale_pid: "lifecycle",
  lifecycle_port_conflict: "lifecycle",
  agent_missing_context: "agent",
  agent_file_hallucination: "agent",
  agent_command_missing: "agent",
  agent_browser: "agent",
  internal_bug: "internal",
  unknown: "unknown",
};

// Strategy per cause
const STRATEGY: Record<
  RootCauseResult["category"],
  Pick<RootCauseResult, "shouldRetry" | "shouldNotifyOperator" | "shouldAdjustConfig">
> = {
  rate_limit: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
  auth_failure: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  network: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
  config: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  lifecycle: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  agent: { shouldRetry: false, shouldNotifyOperator: false, shouldAdjustConfig: false },
  internal: { shouldRetry: false, shouldNotifyOperator: true, shouldAdjustConfig: false },
  unknown: { shouldRetry: true, shouldNotifyOperator: false, shouldAdjustConfig: true },
};

export function classifyRootCause(lastError: string | undefined | null): RootCauseResult {
  if (!lastError) {
    return { cause: "unknown", confidence: 0, category: "unknown", ...STRATEGY.unknown };
  }
  for (const [pattern, cause, confidence] of ROOT_CAUSE_PATTERNS) {
    if (pattern.test(lastError)) {
      const category = CATEGORY_MAP[cause] ?? "unknown";
      return { cause, confidence, category, ...STRATEGY[category] };
    }
  }
  return { cause: "unknown", confidence: 0, category: "unknown", ...STRATEGY.unknown };
}
