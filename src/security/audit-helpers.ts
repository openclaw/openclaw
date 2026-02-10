export type FindingSeverity = "info" | "warn" | "critical";

export function countBySeverity(findings: Array<{ severity: FindingSeverity }>): {
  critical: number;
  warn: number;
  info: number;
} {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === "critical") {
      critical += 1;
    } else if (finding.severity === "warn") {
      warn += 1;
    } else {
      info += 1;
    }
  }
  return { critical, warn, info };
}

export function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((value) => String(value).trim()).filter(Boolean);
}

export function classifyChannelWarningSeverity(message: string): FindingSeverity {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("dms: open") ||
    normalized.includes('grouppolicy="open"') ||
    normalized.includes('dmpolicy="open"')
  ) {
    return "critical";
  }
  if (
    normalized.includes("allows any") ||
    normalized.includes("anyone can dm") ||
    normalized.includes("public")
  ) {
    return "critical";
  }
  if (normalized.includes("locked") || normalized.includes("disabled")) {
    return "info";
  }
  return "warn";
}
