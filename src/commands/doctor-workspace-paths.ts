import fs from "node:fs";
import os from "node:os";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

/**
 * A path-field in openclaw.json that cannot be used on the current host.
 *
 * - `stale-home-prefix`: absolute path whose `/home/<user>`, `/Users/<user>`,
 *   `/root`, or `C:\Users\<user>` prefix does not belong to the current user
 *   or the current OS. Safe to rewrite to a `~`-relative form.
 * - `missing-nonhome`: absolute path that does not exist and does not look
 *   like a home-dir-shaped path (for example `/mnt/data/openclaw-ws`). Reported
 *   so the operator can fix it manually; we never auto-rewrite these.
 */
export type StaleWorkspacePathFinding =
  | {
      kind: "stale-home-prefix";
      location: string;
      agentId?: string;
      currentValue: string;
      proposedRewrite: string;
    }
  | {
      kind: "missing-nonhome";
      location: string;
      agentId?: string;
      currentValue: string;
    };

export type StaleWorkspacePathEnv = {
  homedir: string;
  username: string;
  platform: NodeJS.Platform;
  pathExists: (p: string) => boolean;
};

type HomePrefixKind = "posix" | "win";

// Ordered list of regexes matching a home-directory-shaped prefix.
// Capture group 1 (when present) is the username segment.
const HOME_PREFIX_PATTERNS: Array<{ re: RegExp; kind: HomePrefixKind }> = [
  { re: /^\/home\/([^/]+)(?:\/|$)/, kind: "posix" },
  { re: /^\/Users\/([^/]+)(?:\/|$)/, kind: "posix" },
  { re: /^\/root(?:\/|$)/, kind: "posix" },
  { re: /^[A-Za-z]:[\\/]Users[\\/]([^\\/]+)(?:[\\/]|$)/, kind: "win" },
];

type HomePrefixMatch = {
  matchedPrefix: string;
  extractedUser: string;
  kind: HomePrefixKind;
};

function matchHomePrefix(value: string): HomePrefixMatch | null {
  for (const { re, kind } of HOME_PREFIX_PATTERNS) {
    const m = value.match(re);
    if (!m) {
      continue;
    }
    return {
      matchedPrefix: m[0],
      extractedUser: m[1] ?? "root",
      kind,
    };
  }
  return null;
}

function rewriteToTilde(value: string, match: HomePrefixMatch): string {
  const rest = value.slice(match.matchedPrefix.length);
  if (!rest) {
    return "~";
  }
  // Normalize Windows separators into forward slashes for the tilde form.
  const normalized = match.kind === "win" ? rest.replace(/\\/g, "/") : rest;
  const stripped = normalized.replace(/^\/+/, "");
  return stripped ? `~/${stripped}` : "~";
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    if (/^[A-Za-z]:[\\/]/.test(value)) {
      return true;
    }
    if (value.startsWith("\\") || value.startsWith("/")) {
      return true;
    }
    return false;
  }
  return value.startsWith("/");
}

type WorkspaceEntry = {
  location: string;
  agentId?: string;
  value: string;
};

function collectWorkspaceEntries(cfg: OpenClawConfig): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const defaults = cfg.agents?.defaults?.workspace;
  if (typeof defaults === "string" && defaults.trim()) {
    entries.push({
      location: "agents.defaults.workspace",
      value: defaults.trim(),
    });
  }
  const list = cfg.agents?.list ?? [];
  list.forEach((agent, index) => {
    const raw = agent?.workspace;
    if (typeof raw === "string" && raw.trim()) {
      entries.push({
        location: `agents.list[${index}].workspace`,
        ...(agent.id !== undefined ? { agentId: agent.id } : {}),
        value: raw.trim(),
      });
    }
  });
  return entries;
}

/**
 * Pure detector: returns findings for stale workspace path fields in `cfg`.
 * Does not touch the filesystem beyond the injected `pathExists` probe.
 */
export function detectStaleWorkspacePaths(
  cfg: OpenClawConfig,
  env: StaleWorkspacePathEnv,
): StaleWorkspacePathFinding[] {
  const findings: StaleWorkspacePathFinding[] = [];
  for (const entry of collectWorkspaceEntries(cfg)) {
    const value = entry.value;

    if (value.startsWith("~")) {
      continue;
    }

    // Home-shaped prefixes (`/home/X`, `/Users/X`, `/root`, `C:\Users\X`) are
    // inspected regardless of the current platform — the whole point of this
    // check is to flag cross-OS stale paths, so a Windows-shaped path on a
    // macOS host must still be considered.
    const prefix = matchHomePrefix(value);
    if (prefix) {
      if (env.pathExists(value)) {
        continue;
      }
      const isOurUser = prefix.extractedUser === env.username;
      const homeMatches = env.homedir.length > 0 && value.startsWith(env.homedir);
      if (isOurUser && homeMatches) {
        // Our user, our home root, but the directory is missing locally.
        // Not a cross-OS stale case — the existing `doctor:workspace-status`
        // contribution already surfaces missing-dir concerns, so skip here
        // to avoid duplicate noise.
        continue;
      }
      findings.push({
        kind: "stale-home-prefix",
        location: entry.location,
        ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
        currentValue: value,
        proposedRewrite: rewriteToTilde(value, prefix),
      });
      continue;
    }

    // Non-home path: only worth inspecting if it's absolute on the current
    // platform. Relative paths are resolved by openclaw at load time.
    if (!isAbsolutePath(value, env.platform)) {
      continue;
    }
    if (env.pathExists(value)) {
      continue;
    }
    findings.push({
      kind: "missing-nonhome",
      location: entry.location,
      ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
      currentValue: value,
    });
  }
  return findings;
}

/**
 * Effectful doctor repair: surface stale workspace path findings and, in
 * interactive mode, prompt to rewrite them to `~`-relative form. Returns a
 * new config object; callers should assign the result back to `ctx.cfg`.
 */
function resolveCurrentUsername(): string {
  // os.userInfo() throws (`SystemError [ERR_SYSTEM_ERROR]: A system error
  // occurred: uv_os_get_passwd returned ENOENT`) on systems where the
  // running UID has no /etc/passwd entry — common in containerized or
  // NSS-restricted environments. Doctor must not crash there, so fall
  // back to env vars and finally to an empty string. An empty username
  // is fine for detection: every home-shaped prefix will compare unequal
  // and the path will be flagged for review rather than auto-skipped.
  try {
    const fromUserInfo = os.userInfo().username;
    if (fromUserInfo) {
      return fromUserInfo;
    }
  } catch {
    // fall through to env-based fallback
  }
  return process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? "";
}

export async function maybeRepairStaleWorkspacePaths(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
  options: { nonInteractive: boolean },
): Promise<OpenClawConfig> {
  const findings = detectStaleWorkspacePaths(cfg, {
    homedir: os.homedir(),
    username: resolveCurrentUsername(),
    platform: process.platform,
    pathExists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  });

  if (findings.length === 0) {
    return cfg;
  }

  const stale = findings.filter(
    (f): f is Extract<StaleWorkspacePathFinding, { kind: "stale-home-prefix" }> =>
      f.kind === "stale-home-prefix",
  );
  const untouchable = findings.filter(
    (f): f is Extract<StaleWorkspacePathFinding, { kind: "missing-nonhome" }> =>
      f.kind === "missing-nonhome",
  );

  const lines: string[] = [];
  if (stale.length > 0) {
    lines.push(`Found ${stale.length} workspace path(s) referencing a different OS or user home:`);
    for (const f of stale) {
      lines.push(`- ${f.location}: ${f.currentValue} -> ${f.proposedRewrite}`);
    }
  }
  if (untouchable.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(
      `Found ${untouchable.length} workspace path(s) that do not exist and are not home-shaped (doctor will not touch these):`,
    );
    for (const f of untouchable) {
      lines.push(`- ${f.location}: ${f.currentValue}`);
    }
    lines.push(
      `Fix these manually with ${formatCliCommand("openclaw config set ...")} or by editing openclaw.json.`,
    );
  }
  note(lines.join("\n"), "Workspace paths");

  if (stale.length === 0) {
    return cfg;
  }
  if (options.nonInteractive) {
    note(
      `Rerun ${formatCliCommand("openclaw doctor")} interactively to apply the rewrites, or edit openclaw.json directly.`,
      "Workspace paths",
    );
    return cfg;
  }

  const apply = await prompter.confirm({
    message: `Rewrite ${stale.length} stale workspace path(s) to home-relative form (~/...)?`,
    initialValue: true,
  });
  if (!apply) {
    return cfg;
  }

  const nextAgents = cfg.agents
    ? {
        ...cfg.agents,
        defaults: cfg.agents.defaults ? { ...cfg.agents.defaults } : cfg.agents.defaults,
        list: cfg.agents.list ? cfg.agents.list.map((a) => ({ ...a })) : cfg.agents.list,
      }
    : cfg.agents;

  const next: OpenClawConfig = { ...cfg, agents: nextAgents };

  for (const f of stale) {
    if (f.location === "agents.defaults.workspace") {
      if (next.agents?.defaults) {
        next.agents.defaults.workspace = f.proposedRewrite;
      }
      continue;
    }
    const indexMatch = /^agents\.list\[(\d+)\]\.workspace$/.exec(f.location);
    if (indexMatch && next.agents?.list) {
      const idx = Number(indexMatch[1]);
      const entry = next.agents.list[idx];
      if (entry) {
        next.agents.list[idx] = { ...entry, workspace: f.proposedRewrite };
      }
    }
  }

  return next;
}
