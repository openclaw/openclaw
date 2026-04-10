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
  notes: string;
}

export interface RuntimesOptions {
  json?: boolean;
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
export function discoverRuntimes(): RuntimeInfo[] {
  return KNOWN_RUNTIMES.map((known) => {
    const binaryPath = findBinary(known.binary);
    const found = binaryPath !== null;
    const version = found ? getVersion(known.binary, known.versionFlag) : null;
    const auth = found ? known.authProbe() : UNKNOWN_AUTH;
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
  const runtimes = discoverRuntimes();
  const output = opts.json ? formatRuntimesJson(runtimes) : formatRuntimes(runtimes);
  out.write(output);
  return 0;
}
