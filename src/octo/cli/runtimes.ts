// Octopus Orchestrator — `openclaw octo runtimes` CLI command
//
// Discovers which agentic coding tools are installed and available on
// this machine. Scans PATH for known CLIs, checks version/auth where
// possible, and reports adapter compatibility.
//
// Architecture:
//   discoverRuntimes — scans for known tools, returns structured data
//   formatRuntimes   — renders human-readable report
//   runOctoRuntimes  — composes discover + format, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { execSync } from "node:child_process";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface RuntimeInfo {
  name: string;
  binary: string;
  found: boolean;
  path: string | null;
  version: string | null;
  adapter: "cli_exec" | "pty_tmux" | "structured_subagent" | "structured_acp";
  weight: "lightest" | "light" | "heavy";
  structuredOutput: boolean;
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
  notes: string;
}

const KNOWN_RUNTIMES: KnownRuntime[] = [
  {
    name: "OpenClaw (native subagent)",
    binary: "openclaw",
    versionFlag: "--version",
    adapter: "structured_subagent",
    weight: "lightest",
    structuredOutput: true,
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
    notes: "OpenAI CLI. Supports --json structured output mode. Requires OpenAI API key.",
  },
  {
    name: "Gemini CLI",
    binary: "gemini",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
    notes: "Google CLI. Supports structured output. Requires Google API credentials.",
  },
  {
    name: "Aider",
    binary: "aider",
    versionFlag: "--version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    notes: "AI pair programming tool. Interactive TUI only — driven via PTY/tmux.",
  },
  {
    name: "Cursor (CLI)",
    binary: "cursor",
    versionFlag: "--version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    notes: "Cursor editor CLI. Interactive — driven via PTY/tmux if CLI mode available.",
  },
  {
    name: "GitHub Copilot CLI",
    binary: "gh",
    versionFlag: "copilot --version",
    adapter: "pty_tmux",
    weight: "heavy",
    structuredOutput: false,
    notes: "GitHub Copilot via `gh copilot`. Requires GitHub CLI + Copilot extension.",
  },
  {
    name: "OpenCode",
    binary: "opencode",
    versionFlag: "--version",
    adapter: "cli_exec",
    weight: "light",
    structuredOutput: true,
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
    // Extract first line, trim common prefixes
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
    return {
      name: known.name,
      binary: known.binary,
      found,
      path: binaryPath,
      version,
      adapter: known.adapter,
      weight: known.weight,
      structuredOutput: known.structuredOutput,
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
      lines.push(
        `  [OK] ${rt.name}${ver}  (${rt.adapter}, ${weightLabel(rt.weight)}, ${structured})`,
      );
      lines.push(`       ${rt.path}`);
      lines.push(`       ${rt.notes}`);
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
