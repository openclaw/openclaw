import os from "node:os";
import { runExec } from "../process/exec.js";

export type ExecFn = typeof runExec;

export type WindowsAclEntry = {
  principal: string;
  rights: string[];
  rawRights: string;
  canRead: boolean;
  canWrite: boolean;
};

export type WindowsAclSummary = {
  ok: boolean;
  entries: WindowsAclEntry[];
  untrustedWorld: WindowsAclEntry[];
  untrustedGroup: WindowsAclEntry[];
  trusted: WindowsAclEntry[];
  error?: string;
};

const INHERIT_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
const WORLD_PRINCIPALS = new Set([
  "everyone",
  "users",
  "builtin\\users",
  "authenticated users",
  "nt authority\\authenticated users",
]);
const TRUSTED_BASE = new Set([
  "nt authority\\system",
  "system",
  "builtin\\administrators",
  "creator owner",
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const TRUSTED_SUFFIXES = ["\\administrators", "\\system"];

const SID_RE = /^s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
  "s-1-5-18",
  "s-1-5-32-544",
  "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const STATUS_PREFIXES = [
  "successfully processed",
  "processed",
  "failed processing",
  "no mapping between account names",
];

const normalize = (value: string) => value.trim().toLowerCase();

export function resolveWindowsUserPrincipal(env?: NodeJS.ProcessEnv): string | null {
  const username = env?.USERNAME?.trim() || os.userInfo().username?.trim();
  if (!username) {
    return null;
  }
  const domain = env?.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function buildTrustedPrincipals(env?: NodeJS.ProcessEnv): Set<string> {
  const trusted = new Set<string>(TRUSTED_BASE);
  const principal = resolveWindowsUserPrincipal(env);
  if (principal) {
    trusted.add(normalize(principal));
    const parts = principal.split("\\");
    const userOnly = parts.at(-1);
    if (userOnly) {
      trusted.add(normalize(userOnly));
    }
  }
  const userSid = normalize(env?.USERSID ?? "");
  if (userSid && SID_RE.test(userSid)) {
    trusted.add(userSid);
  }
  return trusted;
}

function classifyPrincipal(
  principal: string,
  trustedPrincipals: Set<string>,
): "trusted" | "world" | "group" {
  const normalized = normalize(principal);

  if (SID_RE.test(normalized)) {
    return TRUSTED_SIDS.has(normalized) || trustedPrincipals.has(normalized) ? "trusted" : "group";
  }

  if (
    trustedPrincipals.has(normalized) ||
    TRUSTED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return "trusted";
  }
  if (
    WORLD_PRINCIPALS.has(normalized) ||
    WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return "world";
  }
  return "group";
}

function rightsFromTokens(tokens: string[]): { canRead: boolean; canWrite: boolean } {
  const upper = tokens.join("").toUpperCase();
  const canWrite =
    upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D");
  const canRead = upper.includes("F") || upper.includes("M") || upper.includes("R");
  return { canRead, canWrite };
}

function isStatusLine(lowerLine: string): boolean {
  return STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix));
}

function stripTargetPrefix(params: {
  trimmedLine: string;
  lowerLine: string;
  normalizedTarget: string;
  lowerTarget: string;
  quotedTarget: string;
  quotedLower: string;
}): string {
  if (params.lowerLine.startsWith(params.lowerTarget)) {
    return params.trimmedLine.slice(params.normalizedTarget.length).trim();
  }
  if (params.lowerLine.startsWith(params.quotedLower)) {
    return params.trimmedLine.slice(params.quotedTarget.length).trim();
  }
  return params.trimmedLine;
}

function parseAceEntry(entry: string): WindowsAclEntry | null {
  if (!entry || !entry.includes("(")) {
    return null;
  }

  const idx = entry.indexOf(":");
  if (idx === -1) {
    return null;
  }

  const principal = entry.slice(0, idx).trim();
  const rawRights = entry.slice(idx + 1).trim();
  const tokens =
    rawRights
      .match(/\(([^)]+)\)/g)
      ?.map((token) => token.slice(1, -1).trim())
      .filter(Boolean) ?? [];

  if (tokens.some((token) => token.toUpperCase() === "DENY")) {
    return null;
  }

  const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
  if (rights.length === 0) {
    return null;
  }

  const { canRead, canWrite } = rightsFromTokens(rights);
  return { principal, rights, rawRights, canRead, canWrite };
}

export function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[] {
  const entries: WindowsAclEntry[] = [];
  const normalizedTarget = targetPath.trim();
  const lowerTarget = normalizedTarget.toLowerCase();
  const quotedTarget = `"${normalizedTarget}"`;
  const quotedLower = quotedTarget.toLowerCase();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (isStatusLine(lower)) {
      continue;
    }

    const entry = stripTargetPrefix({
      trimmedLine: trimmed,
      lowerLine: lower,
      normalizedTarget,
      lowerTarget,
      quotedTarget,
      quotedLower,
    });
    const parsed = parseAceEntry(entry);
    if (!parsed) {
      continue;
    }
    entries.push(parsed);
  }

  return entries;
}

export function summarizeWindowsAcl(
  entries: WindowsAclEntry[],
  env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  const trustedPrincipals = buildTrustedPrincipals(env);
  const trusted: WindowsAclEntry[] = [];
  const untrustedWorld: WindowsAclEntry[] = [];
  const untrustedGroup: WindowsAclEntry[] = [];
  for (const entry of entries) {
    const classification = classifyPrincipal(entry.principal, trustedPrincipals);
    if (classification === "trusted") {
      trusted.push(entry);
    } else if (classification === "world") {
      untrustedWorld.push(entry);
    } else {
      untrustedGroup.push(entry);
    }
  }
  return { trusted, untrustedWorld, untrustedGroup };
}

export async function inspectWindowsAcl(
  targetPath: string,
  opts?: { env?: NodeJS.ProcessEnv; exec?: ExecFn },
): Promise<WindowsAclSummary> {
  const exec = opts?.exec ?? runExec;
  try {
    const { stdout, stderr } = await exec("icacls", [targetPath]);
    const output = `${stdout}\n${stderr}`.trim();
    const entries = parseIcaclsOutput(output, targetPath);
    const { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, opts?.env);
    return { ok: true, entries, trusted, untrustedWorld, untrustedGroup };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      trusted: [],
      untrustedWorld: [],
      untrustedGroup: [],
      error: String(err),
    };
  }
}

export function formatWindowsAclSummary(summary: WindowsAclSummary): string {
  if (!summary.ok) {
    return "unknown";
  }
  const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
  if (untrusted.length === 0) {
    return "trusted-only";
  }
  return untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}

export function formatIcaclsResetCommand(
  targetPath: string,
  opts: { isDir: boolean; env?: NodeJS.ProcessEnv },
): string {
  const user = resolveWindowsUserPrincipal(opts.env) ?? "%USERNAME%";
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  return `icacls "${targetPath}" /inheritance:r /grant:r "${user}:${grant}" /grant:r "SYSTEM:${grant}"`;
}

export function createIcaclsResetCommand(
  targetPath: string,
  opts: { isDir: boolean; env?: NodeJS.ProcessEnv },
): { command: string; args: string[]; display: string } | null {
  const user = resolveWindowsUserPrincipal(opts.env);
  if (!user) {
    return null;
  }
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  const args = [
    targetPath,
    "/inheritance:r",
    "/grant:r",
    `${user}:${grant}`,
    "/grant:r",
    `SYSTEM:${grant}`,
  ];
  return { command: "icacls", args, display: formatIcaclsResetCommand(targetPath, opts) };
}
