type ParsedEnvFlags = {
  flags: string[];
  disablesAll: boolean;
};

// Bootstrap consumers use the same syntax without loading config or package aliases.
export function parseDiagnosticEnvFlags(raw?: string): ParsedEnvFlags {
  const trimmed = raw?.trim() ?? "";
  const lowered = trimmed.toLowerCase();
  if (!lowered) {
    return { flags: [], disablesAll: false };
  }
  if (["0", "false", "off", "none"].includes(lowered)) {
    return { flags: [], disablesAll: true };
  }
  if (["1", "true", "all", "*"].includes(lowered)) {
    return { flags: ["*"], disablesAll: false };
  }
  return {
    flags: trimmed.split(/[,\s]+/),
    disablesAll: false,
  };
}
