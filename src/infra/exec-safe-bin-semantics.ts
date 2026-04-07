import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type SafeBinSemanticValidationParams = {
  binName?: string;
  positional: readonly string[];
};

type SafeBinSemanticRule = {
  validate?: (params: SafeBinSemanticValidationParams) => boolean;
  configWarning?: string;
  rejectSafeBin?: boolean;
};

const JQ_ENV_FILTER_PATTERN = /(^|[^.$A-Za-z0-9_])env([^A-Za-z0-9_]|$)/;
const JQ_ENV_VARIABLE_PATTERN = /\$ENV\b/;
const ALWAYS_DENY_SAFE_BIN_SEMANTICS = () => false;

const UNSAFE_SAFE_BIN_WARNINGS = {
  awk: "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
  cat: "cat reads named files by design, so do not treat it as a stdin-only safeBin; use an explicit executable-path allowlist entry or approval-gated run instead.",
  jq: "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
  ls: "ls enumerates filesystem paths by design, so do not treat it as a stdin-only safeBin; use an explicit executable-path allowlist entry or approval-gated run instead.",
  sed: "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
} as const;

const SAFE_BIN_SEMANTIC_RULES: Readonly<Record<string, SafeBinSemanticRule>> = {
  jq: {
    validate: ({ positional }) =>
      !positional.some(
        (token) => JQ_ENV_FILTER_PATTERN.test(token) || JQ_ENV_VARIABLE_PATTERN.test(token),
      ),
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.jq,
  },
  cat: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.cat,
    rejectSafeBin: true,
  },
  awk: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk,
  },
  gawk: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk,
  },
  mawk: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk,
  },
  nawk: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.awk,
  },
  sed: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.sed,
  },
  gsed: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.sed,
  },
  ls: {
    validate: ALWAYS_DENY_SAFE_BIN_SEMANTICS,
    configWarning: UNSAFE_SAFE_BIN_WARNINGS.ls,
    rejectSafeBin: true,
  },
};

export function normalizeSafeBinName(raw: string): string {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed) {
    return "";
  }
  const tail = trimmed.split(/[\\/]/).at(-1);
  const normalized = tail ?? trimmed;
  return normalized.replace(/\.(?:exe|cmd|bat|com)$/i, "");
}

export function getSafeBinSemanticRule(binName?: string): SafeBinSemanticRule | undefined {
  const normalized = typeof binName === "string" ? normalizeSafeBinName(binName) : "";
  return normalized ? SAFE_BIN_SEMANTIC_RULES[normalized] : undefined;
}

export function isRejectedSafeBin(binName?: string): boolean {
  return Boolean(getSafeBinSemanticRule(binName)?.rejectSafeBin);
}

export function validateSafeBinSemantics(params: SafeBinSemanticValidationParams): boolean {
  return getSafeBinSemanticRule(params.binName)?.validate?.(params) ?? true;
}

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
    const warning = getSafeBinSemanticRule(normalized)?.configWarning;
    if (!warning) {
      continue;
    }
    hits.set(normalized, warning);
  }
  return Array.from(hits.entries())
    .map(([bin, warning]) => ({ bin, warning }))
    .toSorted((a, b) => a.bin.localeCompare(b.bin));
}
