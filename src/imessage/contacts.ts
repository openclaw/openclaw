import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_CONTACTS_LOOKUP_SCRIPT_PATH = path.join(
  os.homedir(),
  "clawd",
  "scripts",
  "contacts_lookup.sh",
);

async function execText(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: opts?.timeoutMs ?? 1500,
      encoding: "utf8",
      maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    });
    return String(stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

function normalizePhoneCandidates(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  // Best-effort normalization for Contacts substring matching.
  // We try the raw value first, then digits-only + suffixes (to handle stored numbers like "(253) 370-4422").
  const digitsOnly = trimmed.replace(/\D/g, "");
  const candidates = [trimmed];
  if (digitsOnly && digitsOnly !== trimmed) {
    candidates.push(digitsOnly);
    if (digitsOnly.length >= 10) {
      candidates.push(digitsOnly.slice(-10));
    }
    if (digitsOnly.length >= 7) {
      candidates.push(digitsOnly.slice(-7));
    }
  }
  return Array.from(new Set(candidates));
}

async function lookupViaUserScript(phoneQuery: string): Promise<string | null> {
  const scriptPath = DEFAULT_CONTACTS_LOOKUP_SCRIPT_PATH;
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const output = await execText("/usr/bin/env", ["bash", scriptPath, phoneQuery]);
  const resolved = output?.trim() ?? "";
  if (!resolved || resolved === "NOT_FOUND" || resolved.startsWith("ERROR:")) {
    return null;
  }
  return resolved;
}

async function lookupViaInlineAppleScript(phoneQuery: string): Promise<string | null> {
  // Self-contained lookup:
  // - First, try the fast Contacts predicate match ("contains")
  // - If that fails, fall back to scanning phone digits and matching suffixes (last 10/7)
  const script = [
    "on digitsOnly(s)",
    '  set out to ""',
    '  set digits to "0123456789"',
    "  repeat with i from 1 to (count of characters of s)",
    "    set c to character i of s",
    "    if digits contains c then set out to out & c",
    "  end repeat",
    "  return out",
    "end digitsOnly",
    "on run argv",
    '  if (count of argv) = 0 then return ""',
    "  set q to item 1 of argv",
    '  tell application "Contacts"',
    "    set matches to people whose value of phones contains q",
    "    if (count of matches) is not 0 then",
    "      set p to item 1 of matches",
    "      try",
    "        return name of p",
    "      on error",
    '        return ""',
    "      end try",
    "    end if",
    "",
    "    set qDigits to my digitsOnly(q)",
    '    if qDigits is "" then return ""',
    "    set qLen to (count of characters of qDigits)",
    '    set qLast10 to ""',
    '    set qLast7 to ""',
    "    if qLen >= 10 then set qLast10 to text (qLen - 9) thru qLen of qDigits",
    "    if qLen >= 7 then set qLast7 to text (qLen - 6) thru qLen of qDigits",
    "",
    "    repeat with p in people",
    "      try",
    "        repeat with ph in phones of p",
    "          set vDigits to my digitsOnly(value of ph as string)",
    "          if vDigits ends with qDigits then return name of p",
    '          if qLast10 is not "" and vDigits ends with qLast10 then return name of p',
    '          if qLast7 is not "" and vDigits ends with qLast7 then return name of p',
    "        end repeat",
    "      end try",
    "    end repeat",
    '    return ""',
    "  end tell",
    "end run",
  ].join("\n");
  const output = await execText("/usr/bin/osascript", ["-e", script, phoneQuery], {
    timeoutMs: 4000,
  });
  const resolved = output?.trim() ?? "";
  return resolved ? resolved : null;
}

export async function resolveContactNameFromPhoneNumber(rawPhone: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const candidates = normalizePhoneCandidates(rawPhone);
  for (const candidate of candidates) {
    const viaScript = await lookupViaUserScript(candidate);
    if (viaScript) {
      return viaScript;
    }
    const viaAppleScript = await lookupViaInlineAppleScript(candidate);
    if (viaAppleScript) {
      return viaAppleScript;
    }
  }
  return null;
}
