import type { SessionSystemPromptReport } from "../../config/sessions/types.js";

type SessionToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

export type ReadableContextReportToolEntry = {
  readonly name: string;
  readonly summaryChars: number;
  readonly schemaChars: number;
  readonly propertiesCount?: number | null;
};

function readNonNegativeNumber(read: () => number | null | undefined): number {
  try {
    const value = read();
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function readOptionalCount(read: () => number | null | undefined): number | null | undefined {
  try {
    const value = read();
    if (value == null) {
      return value;
    }
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function readToolName(entry: SessionToolReportEntry): string | undefined {
  try {
    return typeof entry.name === "string" && entry.name ? entry.name : undefined;
  } catch {
    return undefined;
  }
}

export function readContextReportToolEntries(
  entries: readonly SessionToolReportEntry[],
): ReadableContextReportToolEntry[] {
  return entries.flatMap((entry) => {
    const name = readToolName(entry);
    if (!name) {
      return [];
    }
    return [
      {
        name,
        summaryChars: readNonNegativeNumber(() => entry.summaryChars),
        schemaChars: readNonNegativeNumber(() => entry.schemaChars),
        propertiesCount: readOptionalCount(() => entry.propertiesCount),
      },
    ];
  });
}
