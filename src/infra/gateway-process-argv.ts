import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

function normalizeProcArg(arg: string): string {
  return normalizeLowercaseStringOrEmpty(arg.replaceAll("\\", "/"));
}

export function parseProcCmdline(raw: string): string[] {
  return normalizeStringEntries(raw.split("\0"));
}

/**
 * Parse a Windows command line string into argv-style tokens,
 * handling double-quoted paths (e.g. `"C:\Program Files\node.exe" gateway run`).
 */
export function parseWindowsCmdline(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  for (const char of raw) {
    if (char === '"') {
      inQuote = !inQuote;
    } else if (char === " " && !inQuote) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    args.push(current);
  }
  return args;
}

export function isGatewayArgv(args: string[], opts?: { allowGatewayBinary?: boolean }): boolean {
  const normalized = args.map(normalizeProcArg);
  const exe = (normalized[0] ?? "").replace(/\.(bat|cmd|exe)$/i, "");
  const isGatewayBinary = exe.endsWith("/openclaw-gateway") || exe === "openclaw-gateway";
  if (!normalized.includes("gateway")) {
    return opts?.allowGatewayBinary === true && isGatewayBinary;
  }

  const entryCandidates = [
    "dist/index.js",
    "dist/entry.js",
    "openclaw.mjs",
    "scripts/run-node.mjs",
    "src/entry.ts",
    "src/index.ts",
  ];
  if (normalized.some((arg) => entryCandidates.some((entry) => arg.endsWith(entry)))) {
    return true;
  }

  return (
    exe.endsWith("/openclaw") ||
    exe === "openclaw" ||
    (opts?.allowGatewayBinary === true && isGatewayBinary)
  );
}
