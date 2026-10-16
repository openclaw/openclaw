// Applies semantic validators for safe-bin command arguments.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SafeBinSemanticValidationParams = {
  binName?: string;
  positional: readonly string[];
};

const UNSAFE_SAFE_BIN_WARNINGS = {
  awk: "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
  jq: "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
  sed: "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
} as const;

const DENIED_SAFE_BIN_WARNINGS: ReadonlyMap<string, string> = new Map([
  ["jq", UNSAFE_SAFE_BIN_WARNINGS.jq],
  ["awk", UNSAFE_SAFE_BIN_WARNINGS.awk],
  ["gawk", UNSAFE_SAFE_BIN_WARNINGS.awk],
  ["mawk", UNSAFE_SAFE_BIN_WARNINGS.awk],
  ["nawk", UNSAFE_SAFE_BIN_WARNINGS.awk],
  ["sed", UNSAFE_SAFE_BIN_WARNINGS.sed],
  ["gsed", UNSAFE_SAFE_BIN_WARNINGS.sed],
]);

/** Normalizes a configured safe-bin entry to its executable basename without Windows suffixes. */
export function normalizeSafeBinName(raw: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed) {
    return "";
  }
  const tail = trimmed.split(/[\\/]/).at(-1);
  const normalized = tail ?? trimmed;
  return normalized.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

function getDeniedSafeBinWarning(binName?: string): string | undefined {
  const normalized = typeof binName === "string" ? normalizeSafeBinName(binName) : "";
  return DENIED_SAFE_BIN_WARNINGS.get(normalized);
}

/** Applies command-specific semantic gates for executables that are risky as broad safeBins. */
export function validateSafeBinSemantics(params: SafeBinSemanticValidationParams): boolean {
  return getDeniedSafeBinWarning(params.binName) === undefined;
}

/** Lists configured safeBins that need operator warnings because their semantics are broad. */
export function listRiskyConfiguredSafeBins(entries: Iterable<string>): Array<{
  bin: string;
  warning: string;
}> {
  const hits = new Map<string, string>();
  for (const entry of entries) {
    const normalized = normalizeSafeBinName(entry);
    if (!normalized || hits.has(normalized)) {
      continue;
    }
    const warning = getDeniedSafeBinWarning(normalized);
    if (!warning) {
      continue;
    }
    hits.set(normalized, warning);
  }
  return Array.from(hits.entries())
    .map(([bin, warning]) => ({ bin, warning }))
    .toSorted((a, b) => a.bin.localeCompare(b.bin));
}
