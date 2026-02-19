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

/**
 * Well-known Windows SIDs that are always trusted, regardless of locale.
 *
 * These SIDs appear in SDDL strings and `icacls` output (prefixed with `*`)
 * and are locale-independent, unlike display names which vary by OS language
 * (e.g. "NT AUTHORITY\SYSTEM" vs "NT AUTHORITY\СИСТЕМА" in ru-RU).
 */
const TRUSTED_SIDS = new Set([
  "s-1-5-18", // Local System (NT AUTHORITY\SYSTEM)
  "s-1-5-32-544", // BUILTIN\Administrators
  "s-1-3-0", // Creator Owner
]);

/**
 * Well-known SDDL two-letter abbreviations for trusted principals.
 * Used when parsing SDDL ACE strings from `Get-Acl`.
 */
const TRUSTED_SDDL_ABBREVS = new Set([
  "SY", // Local System
  "BA", // BUILTIN\Administrators
  "CO", // Creator Owner
]);

/**
 * Well-known SDDL abbreviations for world/everyone principals.
 */
const WORLD_SDDL_ABBREVS = new Set([
  "WD", // Everyone
  "BU", // BUILTIN\Users
  "AU", // Authenticated Users
]);

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
  return trusted;
}

function classifyPrincipal(
  principal: string,
  env?: NodeJS.ProcessEnv,
): "trusted" | "world" | "group" {
  const normalized = normalize(principal);
  const trusted = buildTrustedPrincipals(env);
  if (trusted.has(normalized) || TRUSTED_SUFFIXES.some((s) => normalized.endsWith(s))) {
    return "trusted";
  }
  if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((s) => normalized.endsWith(s))) {
    return "world";
  }

  // SID-based fallback: icacls may output raw SIDs (e.g. "*S-1-5-18") when the
  // display name cannot be resolved, or when the locale uses non-ASCII names
  // that get mangled. Check against well-known trusted/world SIDs.
  const sidMatch = normalized.match(/^(?:\*?)(s-1-[\d-]+)$/);
  if (sidMatch) {
    const sid = sidMatch[1];
    if (TRUSTED_SIDS.has(sid)) {
      return "trusted";
    }
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
    if (
      lower.startsWith("successfully processed") ||
      lower.startsWith("processed") ||
      lower.startsWith("failed processing") ||
      lower.startsWith("no mapping between account names")
    ) {
      continue;
    }

    let entry = trimmed;
    if (lower.startsWith(lowerTarget)) {
      entry = trimmed.slice(normalizedTarget.length).trim();
    } else if (lower.startsWith(quotedLower)) {
      entry = trimmed.slice(quotedTarget.length).trim();
    }
    if (!entry) {
      continue;
    }

    const idx = entry.indexOf(":");
    if (idx === -1) {
      continue;
    }

    const principal = entry.slice(0, idx).trim();
    const rawRights = entry.slice(idx + 1).trim();
    const tokens =
      rawRights
        .match(/\(([^)]+)\)/g)
        ?.map((token) => token.slice(1, -1).trim())
        .filter(Boolean) ?? [];
    if (tokens.some((token) => token.toUpperCase() === "DENY")) {
      continue;
    }
    const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
    if (rights.length === 0) {
      continue;
    }
    const { canRead, canWrite } = rightsFromTokens(rights);
    entries.push({ principal, rights, rawRights, canRead, canWrite });
  }

  return entries;
}

/**
 * Parses a Windows SDDL string to extract ACE (Access Control Entry) principals.
 *
 * SDDL principals are locale-independent: "SY" is always SYSTEM regardless of
 * the OS display language. This makes SDDL parsing immune to the localization
 * false-positive that affects icacls text output (e.g. "СИСТЕМА" in ru-RU).
 *
 * @returns classification summary, or null if the SDDL cannot be parsed
 */
export function classifyFromSddl(
  sddl: string,
  _env?: NodeJS.ProcessEnv,
  currentUserSid?: string,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> | null {
  // Extract DACL section: D:...
  const daclMatch = sddl.match(/D:[A-Z]*(\([^)]*\)(?:\([^)]*\))*)/);
  if (!daclMatch) {
    return null;
  }

  // Parse individual ACEs: (ace_type;ace_flags;rights;object_guid;inherit_object_guid;account_sid)
  const acePattern = /\(([^)]+)\)/g;
  const trusted: WindowsAclEntry[] = [];
  const untrustedWorld: WindowsAclEntry[] = [];
  const untrustedGroup: WindowsAclEntry[] = [];

  let match: RegExpExecArray | null;
  while ((match = acePattern.exec(daclMatch[1])) !== null) {
    const parts = match[1].split(";");
    if (parts.length < 6) {
      continue;
    }

    const aceType = parts[0];
    // Skip deny ACEs
    if (aceType === "D") {
      continue;
    }
    // Only process allow ACEs
    if (aceType !== "A") {
      continue;
    }

    const rightsStr = parts[2];
    const accountSid = parts[5];

    // Determine trust level from SDDL abbreviation or raw SID
    const upperSid = accountSid.toUpperCase();
    // Tokenize SDDL rights into 2-character codes to avoid substring false positives
    const rightsTokens = rightsStr.match(/.{1,2}/g) ?? [];
    const rightsSet = new Set(rightsTokens);
    const canWrite =
      rightsSet.has("FA") || rightsSet.has("GA") || rightsSet.has("WD") || rightsSet.has("WO");
    const canRead = rightsSet.has("FA") || rightsSet.has("GA") || rightsSet.has("FR");

    const entry: WindowsAclEntry = {
      principal: accountSid,
      rights: [rightsStr],
      rawRights: rightsStr,
      canRead,
      canWrite,
    };

    if (TRUSTED_SDDL_ABBREVS.has(upperSid)) {
      trusted.push(entry);
    } else if (WORLD_SDDL_ABBREVS.has(upperSid)) {
      untrustedWorld.push(entry);
    } else if (TRUSTED_SIDS.has(accountSid.toLowerCase())) {
      trusted.push(entry);
    } else if (currentUserSid && accountSid.toLowerCase() === currentUserSid.toLowerCase()) {
      // Current user's SID — trusted
      trusted.push(entry);
    } else {
      untrustedGroup.push(entry);
    }
  }

  return { trusted, untrustedWorld, untrustedGroup };
}

export function summarizeWindowsAcl(
  entries: WindowsAclEntry[],
  env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  const trusted: WindowsAclEntry[] = [];
  const untrustedWorld: WindowsAclEntry[] = [];
  const untrustedGroup: WindowsAclEntry[] = [];
  for (const entry of entries) {
    const classification = classifyPrincipal(entry.principal, env);
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

  // Resolve current user's SID for precise trust classification.
  let currentUserSid: string | undefined;
  try {
    const { stdout: whoamiOut } = await exec("whoami", ["/user", "/fo", "csv", "/nh"]);
    const sidMatch = whoamiOut.match(/"(S-1-[\d-]+)"/);
    if (sidMatch) {
      currentUserSid = sidMatch[1];
    }
  } catch {
    // whoami failed — proceed without current user SID
  }

  // Fast path: try SDDL-based classification first.
  // SDDL uses locale-independent SID abbreviations (SY, BA, etc.), avoiding
  // false positives from localized account names (e.g. ru-RU "СИСТЕМА").
  try {
    const escapedPath = targetPath.replace(/'/g, "''").replace(/`/g, "``");
    const { stdout: sddlOut } = await exec("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-Acl '${escapedPath}').Sddl`,
    ]);
    const sddl = sddlOut.trim();
    if (sddl && sddl.startsWith("O:")) {
      const sddlResult = classifyFromSddl(sddl, opts?.env, currentUserSid);
      if (sddlResult) {
        // Also get icacls entries for display purposes (human-readable names)
        try {
          const { stdout, stderr } = await exec("icacls", [targetPath]);
          const output = `${stdout}\n${stderr}`.trim();
          const entries = parseIcaclsOutput(output, targetPath);
          return {
            ok: true,
            entries,
            ...sddlResult,
          };
        } catch {
          // icacls failed but SDDL succeeded — use SDDL entries as display
          return {
            ok: true,
            entries: [
              ...sddlResult.trusted,
              ...sddlResult.untrustedWorld,
              ...sddlResult.untrustedGroup,
            ],
            ...sddlResult,
          };
        }
      }
    }
  } catch {
    // PowerShell not available or failed — fall through to icacls-only path
  }

  // Fallback: icacls-only path (original behavior)
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
