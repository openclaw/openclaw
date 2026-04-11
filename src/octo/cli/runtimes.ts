// Octopus Orchestrator — `openclaw octo runtimes` CLI command
//
// Discovers which agentic coding tools are installed and available on
// this machine. Scans PATH for known CLIs, checks version/auth where
// possible, and reports adapter compatibility and auth status.
//
// Architecture:
//   discoverRuntimes — scans for known tools, returns structured data
//   probeAuth        — reads local credential files for auth/subscription status
//   formatRuntimes   — renders human-readable report
//   runOctoRuntimes  — composes discover + format, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface AuthStatus {
  authenticated: boolean;
  authMode: string | null;
  subscription: string | null;
  rateLimitTier: string | null;
  tokenStatus: "valid" | "expiring_soon" | "expired" | "unknown";
  tokenExpiresAt: string | null;
  detail: string;
}

export interface UsageStats {
  available: boolean;
  source: string;
  todayMessages: number | null;
  todaySessions: number | null;
  todayTokens: number | null;
  todayToolCalls: number | null;
  last7dMessages: number | null;
  last7dSessions: number | null;
  last7dTokens: number | null;
  dailyBreakdown: Array<{
    date: string;
    messages: number | null;
    sessions: number | null;
    tokens: number | null;
    toolCalls: number | null;
  }>;
  lastUpdated: string | null;
  detail: string;
}

export interface ModelInfo {
  slug: string;
  displayName: string;
  contextWindow: number | null;
  reasoning: boolean;
  visible: boolean;
}

export interface CliCapabilities {
  subcommands: string[];
  helpHash: string;
  lastChecked: string;
}

export interface RuntimeInfo {
  name: string;
  binary: string;
  found: boolean;
  path: string | null;
  version: string | null;
  adapter: "cli_exec" | "pty_tmux" | "structured_subagent" | "structured_acp";
  weight: "lightest" | "light" | "heavy";
  structuredOutput: boolean;
  auth: AuthStatus;
  usage: UsageStats;
  models: ModelInfo[];
  capabilities: CliCapabilities | null;
  probe: ProbeResult | null;
  notes: string;
}

export interface ProbeResult {
  available: boolean;
  rawOutput: string;
  parsed: Record<string, unknown>;
  detail: string;
}

export interface RuntimesOptions {
  json?: boolean;
  usage?: boolean;
  probe?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Known runtimes — the tool catalog
// ──────────────────────────────────────────────────────────────────────────

interface KnownRuntime {
  name: string;
  binary: string;
  versionFlag: string;
  adapter: RuntimeInfo["adapter"];
  weight: RuntimeInfo["weight"];
  structuredOutput: boolean;
  authProbe: () => AuthStatus;
  usageProbe: () => UsageStats;
  modelProbe: () => ModelInfo[];
  /** Interactive slash command to probe for live usage/quota. null = no probe available. */
  probeCommand: string | null;
  /** Parse the raw tmux capture-pane output from the probe session. */
  parseProbe: ((raw: string) => ProbeResult) | null;
  /** How long to wait for CLI init before sending the slash command (ms). */
  probeInitWaitMs: number;
  /** How long to wait after sending the command for output to render (ms). */
  probeCommandWaitMs: number;
  notes: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Auth probing — read local credential files (no API calls)
// ──────────────────────────────────────────────────────────────────────────

const UNKNOWN_AUTH: AuthStatus = {
  authenticated: false,
  authMode: null,
  subscription: null,
  rateLimitTier: null,
  tokenStatus: "unknown",
  tokenExpiresAt: null,
  detail: "no credentials found",
};

function tokenExpiry(expiresAtMs: number): Pick<AuthStatus, "tokenStatus" | "tokenExpiresAt"> {
  const now = Date.now();
  const expiresAt = new Date(expiresAtMs).toISOString();
  if (expiresAtMs < now) {
    return { tokenStatus: "expired", tokenExpiresAt: expiresAt };
  }
  // Expiring within 1 hour
  if (expiresAtMs - now < 3600_000) {
    return { tokenStatus: "expiring_soon", tokenExpiresAt: expiresAt };
  }
  return { tokenStatus: "valid", tokenExpiresAt: expiresAt };
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function probeClaudeAuth(): AuthStatus {
  const credPath = path.join(homedir(), ".claude", ".credentials.json");
  const data = readJsonSafe(credPath);
  if (!data) {
    return { ...UNKNOWN_AUTH, detail: "no credentials file at ~/.claude/.credentials.json" };
  }
  const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth?.accessToken) {
    return { ...UNKNOWN_AUTH, detail: "credentials file exists but no OAuth token" };
  }
  const subscription = (oauth.subscriptionType as string) ?? null;
  const rateLimitTier = (oauth.rateLimitTier as string) ?? null;
  const expiresAt = oauth.expiresAt as number | undefined;
  const expiry = expiresAt
    ? tokenExpiry(expiresAt)
    : { tokenStatus: "unknown" as const, tokenExpiresAt: null };

  const subLabel = subscription ?? "unknown plan";
  const tierLabel = rateLimitTier ? ` (${rateLimitTier})` : "";
  return {
    authenticated: true,
    authMode: "oauth (claude.ai)",
    subscription,
    rateLimitTier,
    ...expiry,
    detail: `${subLabel}${tierLabel}, token ${expiry.tokenStatus}`,
  };
}

function probeCodexAuth(): AuthStatus {
  const authPath = path.join(homedir(), ".codex", "auth.json");
  const data = readJsonSafe(authPath);
  if (!data) {
    return { ...UNKNOWN_AUTH, detail: "no auth file at ~/.codex/auth.json" };
  }
  const authMode = (data.auth_mode as string) ?? null;
  const hasApiKey = data.OPENAI_API_KEY != null;
  const tokens = data.tokens as Record<string, unknown> | undefined;
  const hasToken = Boolean(tokens?.access_token);
  const lastRefresh = data.last_refresh as string | undefined;

  if (!hasToken && !hasApiKey) {
    return { ...UNKNOWN_AUTH, authMode, detail: "auth file exists but no token or API key" };
  }

  // ChatGPT OAuth tokens don't store expiry locally — check last refresh age
  let tokenStatus: AuthStatus["tokenStatus"] = "unknown";
  let tokenExpiresAt: string | null = null;
  if (lastRefresh) {
    const refreshTime = new Date(lastRefresh).getTime();
    const age = Date.now() - refreshTime;
    // ChatGPT tokens typically last ~14 days; warn if > 7 days old
    if (age > 14 * 86400_000) {
      tokenStatus = "expired";
    } else if (age > 7 * 86400_000) {
      tokenStatus = "expiring_soon";
    } else {
      tokenStatus = "valid";
    }
    tokenExpiresAt = lastRefresh;
  }

  const modeLabel = authMode === "chatgpt" ? "ChatGPT Plus/Pro" : (authMode ?? "API key");
  return {
    authenticated: true,
    authMode: hasApiKey ? "api_key" : `oauth (${authMode ?? "unknown"})`,
    subscription: authMode === "chatgpt" ? "chatgpt" : hasApiKey ? "api" : null,
    rateLimitTier: null,
    tokenStatus,
    tokenExpiresAt,
    detail: `${modeLabel}, token ${tokenStatus}${lastRefresh ? ` (last refresh: ${lastRefresh.split("T")[0]})` : ""}`,
  };
}

function probeGeminiAuth(): AuthStatus {
  const oauthPath = path.join(homedir(), ".gemini", "oauth_creds.json");
  const data = readJsonSafe(oauthPath);
  if (!data) {
    return { ...UNKNOWN_AUTH, detail: "no OAuth credentials at ~/.gemini/oauth_creds.json" };
  }
  const hasToken = Boolean(data.access_token);
  if (!hasToken) {
    return { ...UNKNOWN_AUTH, detail: "OAuth file exists but no access token" };
  }
  const expiryDate = data.expiry_date as number | undefined;
  const expiry = expiryDate
    ? tokenExpiry(expiryDate)
    : { tokenStatus: "unknown" as const, tokenExpiresAt: null };
  const hasRefresh = Boolean(data.refresh_token);

  return {
    authenticated: true,
    authMode: "oauth (google)",
    subscription: "google_ai",
    rateLimitTier: null,
    ...expiry,
    detail: `Google AI OAuth, token ${expiry.tokenStatus}${hasRefresh ? " (has refresh token)" : ""}`,
  };
}

function probeGhCopilotAuth(): AuthStatus {
  // gh auth uses ~/.config/gh/hosts.yml
  try {
    const result = execSync("gh auth status 2>&1", { encoding: "utf-8", timeout: 5000 });
    const loggedIn = result.includes("Logged in");
    return {
      authenticated: loggedIn,
      authMode: "oauth (github)",
      subscription: loggedIn ? "github_copilot" : null,
      rateLimitTier: null,
      tokenStatus: loggedIn ? "valid" : "unknown",
      tokenExpiresAt: null,
      detail: loggedIn
        ? "GitHub authenticated, Copilot access depends on subscription"
        : "not logged in to GitHub CLI",
    };
  } catch {
    return { ...UNKNOWN_AUTH, detail: "could not check gh auth status" };
  }
}

function noAuthProbe(): AuthStatus {
  return { ...UNKNOWN_AUTH, detail: "auth probing not implemented for this tool" };
}

// ──────────────────────────────────────────────────────────────────────────
// Usage probing — read local usage data (no API calls)
// ──────────────────────────────────────────────────────────────────────────

const NO_USAGE: UsageStats = {
  available: false,
  source: "none",
  todayMessages: null,
  todaySessions: null,
  todayTokens: null,
  todayToolCalls: null,
  last7dMessages: null,
  last7dSessions: null,
  last7dTokens: null,
  dailyBreakdown: [],
  lastUpdated: null,
  detail: "no local usage data available",
};

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function last7dDates(): Set<string> {
  const dates = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < 7; i++) {
    dates.add(new Date(now - i * 86400_000).toISOString().split("T")[0]);
  }
  return dates;
}

function probeClaudeUsage(): UsageStats {
  const statsPath = path.join(homedir(), ".claude", "stats-cache.json");
  const data = readJsonSafe(statsPath);
  if (!data) {
    return { ...NO_USAGE, detail: "no stats-cache.json at ~/.claude/" };
  }
  const days =
    (data.dailyActivity as Array<{
      date: string;
      messageCount: number;
      sessionCount: number;
      toolCallCount: number;
    }>) ?? [];
  const lastUpdated = (data.lastComputedDate as string) ?? null;
  const today = todayStr();
  const recent7d = last7dDates();

  const todayData = days.find((d) => d.date === today);
  const last7d = days.filter((d) => recent7d.has(d.date));

  const breakdown = last7d.map((d) => ({
    date: d.date,
    messages: d.messageCount,
    sessions: d.sessionCount,
    tokens: null as number | null,
    toolCalls: d.toolCallCount,
  }));

  const sum7dMsgs = last7d.reduce((s, d) => s + d.messageCount, 0);
  const sum7dSessions = last7d.reduce((s, d) => s + d.sessionCount, 0);

  const stale = lastUpdated !== today ? ` (stale — last updated ${lastUpdated})` : "";
  return {
    available: true,
    source: "~/.claude/stats-cache.json",
    todayMessages: todayData?.messageCount ?? 0,
    todaySessions: todayData?.sessionCount ?? 0,
    todayTokens: null,
    todayToolCalls: todayData?.toolCallCount ?? 0,
    last7dMessages: sum7dMsgs,
    last7dSessions: sum7dSessions,
    last7dTokens: null,
    dailyBreakdown: breakdown,
    lastUpdated,
    detail: `${last7d.length} days of data, ${sum7dMsgs} messages, ${sum7dSessions} sessions (7d)${stale}`,
  };
}

function probeCodexUsage(): UsageStats {
  const dbPath = path.join(homedir(), ".codex", "state_5.sqlite");
  try {
    // Use sqlite3 CLI to query — avoids native module dependency
    const today = todayStr();
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT date(created_at, 'unixepoch') as day, SUM(tokens_used) as tokens, COUNT(*) as sessions FROM threads WHERE created_at > strftime('%s', 'now', '-30 days') GROUP BY day ORDER BY day DESC;"`,
      { encoding: "utf-8", timeout: 5000 },
    );
    const rows = result.trim().split("\n").filter(Boolean);
    let todayTokens = 0;
    let todaySessions = 0;
    let sum7dTokens = 0;
    let sum7dSessions = 0;
    const breakdown: UsageStats["dailyBreakdown"] = [];

    for (const row of rows) {
      const [day, tokens, sessions] = row.split("|");
      const t = parseInt(tokens ?? "0", 10);
      const s = parseInt(sessions ?? "0", 10);
      sum7dTokens += t;
      sum7dSessions += s;
      if (day === today) {
        todayTokens = t;
        todaySessions = s;
      }
      breakdown.push({
        date: day ?? "",
        messages: null,
        sessions: s,
        tokens: t,
        toolCalls: null,
      });
    }

    return {
      available: true,
      source: "~/.codex/state_5.sqlite",
      todayMessages: null,
      todaySessions,
      todayTokens,
      todayToolCalls: null,
      last7dMessages: null,
      last7dSessions: sum7dSessions,
      last7dTokens: sum7dTokens,
      dailyBreakdown: breakdown,
      lastUpdated: breakdown[0]?.date ?? null,
      detail: `${breakdown.length} days of data, ${(sum7dTokens / 1_000_000).toFixed(1)}M tokens, ${sum7dSessions} sessions (30d)`,
    };
  } catch {
    return {
      ...NO_USAGE,
      source: "~/.codex/state_5.sqlite",
      detail: "could not query Codex SQLite database",
    };
  }
}

function noUsageProbe(): UsageStats {
  return NO_USAGE;
}

// ──────────────────────────────────────────────────────────────────────────
// Model availability probing
// ──────────────────────────────────────────────────────────────────────────

function probeClaudeModels(): ModelInfo[] {
  // Claude Code doesn't expose a model list command, but we know the available
  // models from the subscription tier (detected in auth probe)
  const credPath = path.join(homedir(), ".claude", ".credentials.json");
  const data = readJsonSafe(credPath);
  const oauth = (data?.claudeAiOauth as Record<string, unknown>) ?? {};
  const sub = (oauth.subscriptionType as string) ?? "free";

  const baseModels: ModelInfo[] = [
    {
      slug: "claude-sonnet-4-6",
      displayName: "Sonnet 4.6",
      contextWindow: 200000,
      reasoning: true,
      visible: true,
    },
    {
      slug: "claude-haiku-4-5",
      displayName: "Haiku 4.5",
      contextWindow: 200000,
      reasoning: true,
      visible: true,
    },
  ];
  if (sub === "max" || sub === "pro") {
    baseModels.unshift({
      slug: "claude-opus-4-6",
      displayName: "Opus 4.6",
      contextWindow: 1000000,
      reasoning: true,
      visible: true,
    });
  }
  return baseModels;
}

function probeCodexModels(): ModelInfo[] {
  const cachePath = path.join(homedir(), ".codex", "models_cache.json");
  const data = readJsonSafe(cachePath);
  if (!data) {
    return [];
  }
  const models = (data.models as Array<Record<string, unknown>>) ?? [];
  return models
    .filter((m) => (m.visibility as string) !== "hide")
    .map((m) => ({
      slug: (m.slug as string) ?? "unknown",
      displayName: (m.display_name as string) ?? (m.slug as string) ?? "unknown",
      contextWindow: (m.context_window as number) ?? null,
      reasoning:
        Array.isArray(m.supported_reasoning_levels) && m.supported_reasoning_levels.length > 0,
      visible: true,
    }));
}

function noModelProbe(): ModelInfo[] {
  return [];
}

// ──────────────────────────────────────────────────────────────────────────
// CLI capability indexing
// ──────────────────────────────────────────────────────────────────────────

function probeCli(binary: string): CliCapabilities | null {
  try {
    const helpOutput = execSync(`${binary} --help 2>&1`, { encoding: "utf-8", timeout: 10000 });
    // Extract subcommand names from help output
    const lines = helpOutput.split("\n");
    const subcommands: string[] = [];
    let inCommands = false;
    for (const line of lines) {
      if (/commands?:/i.test(line)) {
        inCommands = true;
        continue;
      }
      if (inCommands) {
        // Most CLIs indent subcommands with 2+ spaces
        const match = line.match(/^\s{2,}(\S+)/);
        if (match) {
          subcommands.push(match[1]);
        } else if (line.trim() === "" || /^[A-Z]/i.test(line.trim())) {
          // Empty line or new section header ends the commands block
          if (subcommands.length > 0) {
            inCommands = false;
          }
        }
      }
    }
    // Simple hash for change detection
    const sorted = subcommands.toSorted();
    const hash = sorted.join(",");
    const hashCode = Array.from(hash).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    return {
      subcommands,
      helpHash: hashCode.toString(16),
      lastChecked: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// TUI probe — spawn interactive session, run slash command, capture output
// ──────────────────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Spawn a tmux session, wait for the CLI to init, send a slash command,
 * capture the pane output, and kill the session. Human-equivalent operation.
 */
function runTuiProbe(
  binary: string,
  slashCommand: string,
  sessionName: string,
  initWaitMs = 4000,
  commandWaitMs = 5000,
): string | null {
  try {
    // Kill any stale probe session
    try {
      execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { timeout: 3000 });
    } catch {
      // ignore — session may not exist
    }

    // Spawn the CLI in a detached tmux session
    execSync(`tmux new-session -d -s ${sessionName} -x 200 -y 50 '${binary}'`, {
      timeout: 5000,
    });

    // Wait for CLI to initialize
    execSync(`sleep ${initWaitMs / 1000}`, { timeout: initWaitMs + 2000 });

    // Send the slash command
    execSync(`tmux send-keys -t ${sessionName} '${slashCommand}' Enter`, { timeout: 3000 });

    // Wait for output to render
    execSync(`sleep ${commandWaitMs / 1000}`, { timeout: commandWaitMs + 2000 });

    // Capture the pane content
    const raw = execSync(`tmux capture-pane -t ${sessionName} -p -S -50`, {
      encoding: "utf-8",
      timeout: 5000,
    });

    // Kill the session
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { timeout: 3000 });
    } catch {
      // best effort cleanup
    }

    return stripAnsi(raw);
  } catch {
    // Clean up on failure
    try {
      execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { timeout: 3000 });
    } catch {
      // ignore
    }
    return null;
  }
}

function parseClaudeProbe(raw: string): ProbeResult {
  // /cost output contains cost and usage info
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed: Record<string, unknown> = {};

  for (const line of lines) {
    const costMatch = line.match(/\$?([\d.]+)/);
    if (line.toLowerCase().includes("cost") && costMatch) {
      parsed.cost = parseFloat(costMatch[1]);
    }
    if (line.toLowerCase().includes("subscription")) {
      parsed.subscription = true;
    }
    if (line.toLowerCase().includes("token")) {
      const tokenMatch = line.match(/([\d,]+)\s*tokens?/i);
      if (tokenMatch) {
        parsed.tokens = parseInt(tokenMatch[1].replace(/,/g, ""), 10);
      }
    }
  }

  const costStr = typeof parsed.cost === "number" ? parsed.cost.toFixed(4) : "unknown";
  return {
    available: true,
    rawOutput: raw,
    parsed,
    detail: parsed.subscription
      ? "subscription-based (no per-session cost)"
      : "session cost: $" + costStr,
  };
}

function parseCodexProbe(raw: string): ProbeResult {
  // /status output format: "gpt-5.4 default · 100% left · ~/path"
  // The percentage is "X% left" (remaining), NOT "X% used"
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed: Record<string, unknown> = {};

  for (const line of lines) {
    // Codex format: "X% left" means X% remaining
    const leftMatch = line.match(/([\d.]+)%\s*left/i);
    if (leftMatch) {
      parsed.remainingPercent = parseFloat(leftMatch[1]);
      parsed.usedPercent = 100 - (parsed.remainingPercent as number);
    }
    // Also check "X% used" format as fallback
    const usedMatch = line.match(/([\d.]+)%\s*used/i);
    if (usedMatch && parsed.usedPercent == null) {
      parsed.usedPercent = parseFloat(usedMatch[1]);
      parsed.remainingPercent = 100 - (parsed.usedPercent as number);
    }
    // Model info in the status line
    const modelMatch = line.match(/(gpt-[\w.-]+)\s*(?:default)?/i);
    if (modelMatch) {
      parsed.model = modelMatch[1];
    }
    // Reset time
    const resetMatch = line.match(/reset.*?(\d+\s*(?:min|hour|h|m))/i);
    if (resetMatch) {
      parsed.resetIn = resetMatch[1];
    }
    // Plan type
    if (line.toLowerCase().includes("pro") || line.toLowerCase().includes("plus")) {
      parsed.plan = line;
    }
  }

  const remainingPct = parsed.remainingPercent as number | undefined;
  const usedPct = parsed.usedPercent as number | undefined;
  const modelStr = typeof parsed.model === "string" ? parsed.model + " · " : "";

  return {
    available: true,
    rawOutput: raw,
    parsed,
    detail:
      remainingPct != null
        ? modelStr +
          remainingPct.toFixed(0) +
          "% remaining, " +
          (usedPct ?? 0).toFixed(0) +
          "% used" +
          (typeof parsed.resetIn === "string" ? ", resets in " + parsed.resetIn : "")
        : "quota data captured (check raw output for details)",
  };
}

function parseGeminiProbe(raw: string): ProbeResult {
  // /stats output contains token usage and remaining quota per model
  // Also parse the startup banner for plan info (e.g., "Plan: Gemini Code Assist in Google One AI Ultra")
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const parsed: Record<string, unknown> = {};

  // Detect plan from startup banner
  for (const line of lines) {
    const planMatch = line.match(/Plan:\s*(.+)/i);
    if (planMatch) {
      const planStr = planMatch[1].trim();
      parsed.plan = planStr;
      if (planStr.toLowerCase().includes("ultra")) {
        parsed.tier = "ultra";
      } else if (planStr.toLowerCase().includes("pro")) {
        parsed.tier = "pro";
      } else {
        parsed.tier = "free";
      }
    }
  }
  const models: Array<{ model: string; remaining: string }> = [];

  for (const line of lines) {
    // Look for remaining percentage
    const remainMatch = line.match(/([\d.]+)%\s*(?:remaining|left|available)/i);
    if (remainMatch) {
      parsed.remainingPercent = parseFloat(remainMatch[1]);
    }
    // Look for model-specific quota
    const modelMatch = line.match(/(gemini[\w.-]+).*?([\d.]+)%/i);
    if (modelMatch) {
      models.push({ model: modelMatch[1], remaining: modelMatch[2] + "%" });
    }
    // Look for token counts
    const tokenMatch = line.match(/([\d,]+)\s*tokens?/i);
    if (tokenMatch && !parsed.totalTokens) {
      parsed.totalTokens = parseInt(tokenMatch[1].replace(/,/g, ""), 10);
    }
    // Look for reset time
    const resetMatch = line.match(/reset.*?(\d{1,2}:\d{2}|\d+\s*(?:min|hour|h|m))/i);
    if (resetMatch) {
      parsed.resetAt = resetMatch[1];
    }
  }

  if (models.length > 0) {
    parsed.models = models;
  }

  const remaining = parsed.remainingPercent as number | undefined;

  return {
    available: true,
    rawOutput: raw,
    parsed,
    detail:
      remaining != null
        ? remaining.toFixed(0) +
          "% remaining" +
          (typeof parsed.resetAt === "string" ? ", resets at " + parsed.resetAt : "")
        : models.length > 0
          ? models.map((m) => m.model + ": " + m.remaining + " remaining").join(", ")
          : typeof parsed.plan === "string"
            ? parsed.plan + (typeof parsed.tier === "string" ? " (" + parsed.tier + " tier)" : "")
            : "stats captured (check raw output for details)",
  };
}

function alwaysAvailableAuth(): AuthStatus {
  return {
    authenticated: true,
    authMode: "native",
    subscription: "openclaw",
    rateLimitTier: "configured_provider",
    tokenStatus: "valid",
    tokenExpiresAt: null,
    detail: "native — uses your configured OpenClaw model provider",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime catalog
// ──────────────────────────────────────────────────────────────────────────

const KNOWN_RUNTIMES: KnownRuntime[] = [
  {
    name: "OpenClaw (native subagent)",
    binary: "openclaw",
    versionFlag: "--version",
    adapter: "structured_subagent",
    weight: "lightest",
    structuredOutput: true,
    authProbe: alwaysAvailableAuth,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: null,
    parseProbe: null,
    probeInitWaitMs: 0,
    probeCommandWaitMs: 0,
    notes:
      "Native OpenClaw agent loop — no external tool needed. Always available when Gateway is running.",
  },
  {
    name: "Claude Code",
    binary: "claude",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
    authProbe: probeClaudeAuth,
    usageProbe: probeClaudeUsage,
    modelProbe: probeClaudeModels,
    probeCommand: "/cost",
    parseProbe: parseClaudeProbe,
    probeInitWaitMs: 4000,
    probeCommandWaitMs: 5000,
    notes:
      "Anthropic CLI. Supports --output-format stream-json for structured output. Requires Anthropic API key or OAuth.",
  },
  {
    name: "OpenAI Codex",
    binary: "codex",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
    authProbe: probeCodexAuth,
    usageProbe: probeCodexUsage,
    modelProbe: probeCodexModels,
    probeCommand: "/status",
    parseProbe: parseCodexProbe,
    probeInitWaitMs: 4000,
    probeCommandWaitMs: 5000,
    notes:
      "OpenAI CLI. Supports --json structured output mode. Requires OpenAI API key or ChatGPT OAuth.",
  },
  {
    name: "Gemini CLI",
    binary: "gemini",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
    authProbe: probeGeminiAuth,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: "/stats",
    parseProbe: parseGeminiProbe,
    probeInitWaitMs: 8000,
    probeCommandWaitMs: 8000,
    notes: "Google CLI. Supports structured output. Requires Google API credentials.",
  },
  {
    name: "Aider",
    binary: "aider",
    versionFlag: "--version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    authProbe: noAuthProbe,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: null,
    parseProbe: null,
    probeInitWaitMs: 0,
    probeCommandWaitMs: 0,
    notes: "AI pair programming tool. Interactive TUI only — driven via PTY/tmux.",
  },
  {
    name: "Cursor (CLI)",
    binary: "cursor",
    versionFlag: "--version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    authProbe: noAuthProbe,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: null,
    parseProbe: null,
    probeInitWaitMs: 0,
    probeCommandWaitMs: 0,
    notes: "Cursor editor CLI. Interactive — driven via PTY/tmux if CLI mode available.",
  },
  {
    name: "GitHub Copilot CLI",
    binary: "gh",
    versionFlag: "copilot --version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    authProbe: probeGhCopilotAuth,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: null,
    parseProbe: null,
    probeInitWaitMs: 0,
    probeCommandWaitMs: 0,
    notes: "GitHub Copilot via `gh copilot`. Requires GitHub CLI + Copilot extension.",
  },
  {
    name: "OpenCode",
    binary: "opencode",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
    authProbe: noAuthProbe,
    usageProbe: noUsageProbe,
    modelProbe: noModelProbe,
    probeCommand: null,
    parseProbe: null,
    probeInitWaitMs: 0,
    probeCommandWaitMs: 0,
    notes: "Open-source coding agent. Supports structured output mode.",
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────

function findBinary(binary: string): string | null {
  try {
    const result = execSync(`which ${binary} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function getVersion(binary: string, versionFlag: string): string | null {
  try {
    const result = execSync(`${binary} ${versionFlag} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    const firstLine = result.trim().split("\n")[0] ?? "";
    return firstLine.replace(/^v/, "").trim() || null;
  } catch {
    return null;
  }
}

/** Discover all known runtimes on this machine. */
export function discoverRuntimes(opts?: {
  includeUsage?: boolean;
  probe?: boolean;
}): RuntimeInfo[] {
  return KNOWN_RUNTIMES.map((known) => {
    const binaryPath = findBinary(known.binary);
    const found = binaryPath !== null;
    const version = found ? getVersion(known.binary, known.versionFlag) : null;
    const auth = found ? known.authProbe() : UNKNOWN_AUTH;
    const usage = found && opts?.includeUsage ? known.usageProbe() : NO_USAGE;
    const models = found && opts?.includeUsage ? known.modelProbe() : [];
    const capabilities = found && opts?.includeUsage ? probeCli(known.binary) : null;

    // TUI probe: spawn interactive session, run slash command, capture output
    let probe: ProbeResult | null = null;
    if (found && opts?.probe && known.probeCommand && known.parseProbe) {
      const sessionName = `octo-probe-${known.binary.replace(/[^a-z0-9]/g, "")}`;
      process.stdout.write(`  Probing ${known.name} (${known.probeCommand})...\n`);
      const raw = runTuiProbe(
        known.binary,
        known.probeCommand,
        sessionName,
        known.probeInitWaitMs,
        known.probeCommandWaitMs,
      );
      if (raw) {
        probe = known.parseProbe(raw);
      } else {
        probe = {
          available: false,
          rawOutput: "",
          parsed: {},
          detail: "probe failed — could not capture TUI output",
        };
      }
    }

    return {
      name: known.name,
      binary: known.binary,
      found,
      path: binaryPath,
      version,
      adapter: known.adapter,
      weight: known.weight,
      structuredOutput: known.structuredOutput,
      auth,
      usage,
      models,
      capabilities,
      probe,
      notes: known.notes,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────────────────────────────────

function weightLabel(weight: RuntimeInfo["weight"]): string {
  switch (weight) {
    case "lightest":
      return "lightest";
    case "light":
      return "light";
    case "heavy":
      return "heavy";
    default:
      return String(weight);
  }
}

function authStatusIcon(auth: AuthStatus): string {
  if (!auth.authenticated) {
    return "NO AUTH";
  }
  switch (auth.tokenStatus) {
    case "expired":
      return "EXPIRED";
    case "expiring_soon":
      return "EXPIRING";
    case "valid":
      return "OK";
    default:
      return "AUTH OK";
  }
}

/** Format runtimes as human-readable report. */
export function formatRuntimes(runtimes: RuntimeInfo[]): string {
  const lines: string[] = [];
  lines.push("Octopus Available Runtimes");
  lines.push("=========================");
  lines.push("");

  const available = runtimes.filter((r) => r.found);
  const unavailable = runtimes.filter((r) => !r.found);

  if (available.length > 0) {
    lines.push(`Available (${available.length}):`);
    for (const rt of available) {
      const ver = rt.version ? ` v${rt.version}` : "";
      const structured = rt.structuredOutput ? "structured" : "interactive";
      const authIcon = authStatusIcon(rt.auth);
      lines.push(
        `  [${authIcon}] ${rt.name}${ver}  (${rt.adapter}, ${weightLabel(rt.weight)}, ${structured})`,
      );
      lines.push(`       path: ${rt.path}`);
      lines.push(`       auth: ${rt.auth.detail}`);
      if (rt.auth.subscription) {
        lines.push(
          `       plan: ${rt.auth.subscription}${rt.auth.rateLimitTier ? ` / ${rt.auth.rateLimitTier}` : ""}`,
        );
      }
      if (rt.models.length > 0) {
        const modelNames = rt.models.map((m) => {
          const ctx = m.contextWindow ? ` (${(m.contextWindow / 1000).toFixed(0)}K ctx)` : "";
          return `${m.displayName}${ctx}`;
        });
        lines.push(`       models: ${modelNames.join(", ")}`);
      }
      if (rt.usage.available) {
        lines.push(`       usage: ${rt.usage.detail}`);
        if (rt.usage.dailyBreakdown.length > 0) {
          lines.push("       recent:");
          for (const day of rt.usage.dailyBreakdown.slice(0, 5)) {
            const parts: string[] = [day.date];
            if (day.tokens != null) {
              parts.push(`${(day.tokens / 1_000_000).toFixed(1)}M tokens`);
            }
            if (day.messages != null) {
              parts.push(`${day.messages} msgs`);
            }
            if (day.sessions != null) {
              parts.push(`${day.sessions} sessions`);
            }
            lines.push(`         ${parts.join("  ")}`);
          }
        }
      }
      if (rt.capabilities) {
        lines.push(
          `       commands: ${rt.capabilities.subcommands.length} subcommands (${rt.capabilities.subcommands.slice(0, 8).join(", ")}${rt.capabilities.subcommands.length > 8 ? ", ..." : ""})`,
        );
      }
      if (rt.probe) {
        lines.push(`       live: ${rt.probe.detail}`);
      }
      lines.push("");
    }
  } else {
    lines.push(
      "No external runtimes found. Only structured_subagent (OpenClaw native) is available.",
    );
    lines.push("");
  }

  if (unavailable.length > 0) {
    lines.push(`Not installed (${unavailable.length}):`);
    for (const rt of unavailable) {
      lines.push(`  [--] ${rt.name}  (${rt.binary} not found in PATH)`);
    }
    lines.push("");
  }

  // Summary recommendation
  const ready = available.filter((r) => r.auth.authenticated && r.auth.tokenStatus !== "expired");
  const expired = available.filter((r) => r.auth.tokenStatus === "expired");
  const noAuth = available.filter((r) => !r.auth.authenticated);

  if (expired.length > 0) {
    lines.push(
      `WARNING: ${expired.map((r) => r.name).join(", ")} — token expired. Run the tool's login/auth command to refresh.`,
    );
    lines.push("");
  }
  if (noAuth.length > 0) {
    lines.push(
      `NOTE: ${noAuth.map((r) => r.name).join(", ")} — not authenticated. Set up credentials before using.`,
    );
    lines.push("");
  }

  lines.push(
    `Ready to use: ${ready.length} runtime${ready.length === 1 ? "" : "s"} (${ready.map((r) => r.name).join(", ")})`,
  );
  lines.push("");
  lines.push(
    "Adapter preference: structured_subagent (lightest) > cli_exec (light) > pty_tmux (heavy)",
  );
  lines.push(
    "Use cli_exec when the tool supports structured output. Fall back to pty_tmux for interactive-only tools.",
  );
  lines.push("");
  return lines.join("\n");
}

/** Format runtimes as JSON. */
export function formatRuntimesJson(runtimes: RuntimeInfo[]): string {
  return JSON.stringify(runtimes, null, 2) + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────

/** Entry point for `openclaw octo runtimes`. Returns exit code 0. */
export function runOctoRuntimes(
  opts: RuntimesOptions,
  out: { write: (s: string) => void } = process.stdout,
): number {
  const runtimes = discoverRuntimes({
    includeUsage: opts.usage ?? opts.probe ?? false,
    probe: opts.probe ?? false,
  });
  const output = opts.json ? formatRuntimesJson(runtimes) : formatRuntimes(runtimes);
  out.write(output);
  return 0;
}
