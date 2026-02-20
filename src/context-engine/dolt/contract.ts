import { DOLT_RECORD_LEVELS, type DoltRecordLevel } from "./store/types.js";

export const DOLT_SUMMARY_TYPES = ["leaf", "bindle"] as const;

export type DoltSummaryType = (typeof DOLT_SUMMARY_TYPES)[number];

export type DoltSummaryFrontmatter = {
  summaryType: DoltSummaryType;
  datesCovered: {
    startEpochMs: number;
    endEpochMs: number;
  };
  children: string[];
  finalizedAtReset: boolean;
};

export type DoltParsedSummaryDocument = {
  frontmatter: DoltSummaryFrontmatter;
  body: string;
};

export type DoltSummaryFrontmatterSerializeOptions = {
  includeChildren?: boolean;
};

/**
 * Render canonical Dolt summary front-matter with deterministic key order.
 */
export function serializeDoltSummaryFrontmatter(
  frontmatter: DoltSummaryFrontmatter,
  options: DoltSummaryFrontmatterSerializeOptions = {},
): string {
  const normalized = normalizeFrontmatter(frontmatter);
  const includeChildren = options.includeChildren !== false;
  const lines = [
    "---",
    `summary-type: ${normalized.summaryType}`,
    `dates-covered: ${normalized.datesCovered.startEpochMs}|${normalized.datesCovered.endEpochMs}`,
    `finalized-at-reset: ${normalized.finalizedAtReset ? "true" : "false"}`,
  ];
  if (includeChildren) {
    const children = normalized.children
      .map((pointer) => `'${escapeYamlSingleQuoted(pointer)}'`)
      .join(", ");
    lines.splice(3, 0, `children: [${children}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Parse and validate a summary string that must begin with Dolt front-matter.
 */
export function parseDoltSummaryDocument(summary: string): DoltParsedSummaryDocument {
  const extracted = extractLeadingFrontmatter(summary);
  if (!extracted) {
    throw new Error("Dolt summary is missing required YAML front-matter block.");
  }
  const parsed = parseDoltSummaryFrontmatterLines(extracted.frontmatterLines);
  return {
    frontmatter: parsed,
    body: extracted.body,
  };
}

/**
 * Remove only a valid leading Dolt front-matter block.
 */
export function stripLeadingDoltSummaryFrontmatter(summary: string): string {
  try {
    const parsed = parseDoltSummaryDocument(summary);
    return parsed.body;
  } catch {
    return summary;
  }
}

/**
 * Prefix canonical Dolt front-matter and strip an existing valid block if present.
 */
export function prefixDoltSummaryFrontmatter(params: {
  summary: string;
  frontmatter: DoltSummaryFrontmatter;
  serializeOptions?: DoltSummaryFrontmatterSerializeOptions;
}): string {
  const summaryWithoutFrontmatter = stripLeadingDoltSummaryFrontmatter(params.summary).trimStart();
  const frontmatter = serializeDoltSummaryFrontmatter(params.frontmatter, params.serializeOptions);
  return `${frontmatter}\n${summaryWithoutFrontmatter}`;
}

/**
 * Validate direct lineage level constraints.
 */
export function validateDoltLineageEdgeLevels(params: {
  parentLevel: DoltRecordLevel;
  childLevel: DoltRecordLevel;
  parentPointer: string;
  childPointer: string;
}): void {
  const expectedChildLevel = expectedChildLevelForParent(params.parentLevel);
  if (!expectedChildLevel) {
    throw new Error(
      `Dolt lineage violation: ${params.parentPointer} (${params.parentLevel}) cannot have children.`,
    );
  }
  if (params.childLevel !== expectedChildLevel) {
    throw new Error(
      `Dolt lineage violation: ${params.parentPointer} (${params.parentLevel}) can only reference ${expectedChildLevel} children; received ${params.childPointer} (${params.childLevel}).`,
    );
  }
}

/**
 * Validate chronological ordering for a direct child set.
 */
export function validateDoltChildrenChronologicalOrder(params: {
  parentPointer: string;
  children: Array<{ pointer: string; eventTsMs: number }>;
}): void {
  let previous: { pointer: string; eventTsMs: number } | null = null;
  for (const child of params.children) {
    const eventTsMs = requireEpochMs(child.eventTsMs, `child event timestamp for ${child.pointer}`);
    if (previous && eventTsMs < previous.eventTsMs) {
      throw new Error(
        `Dolt lineage violation: children for ${params.parentPointer} must be chronological; ${child.pointer} (${eventTsMs}) precedes ${previous.pointer} (${previous.eventTsMs}).`,
      );
    }
    previous = {
      pointer: child.pointer,
      eventTsMs,
    };
  }
}

function parseDoltSummaryFrontmatterLines(frontmatterLines: string): DoltSummaryFrontmatter {
  const values = new Map<string, string>();
  const lines = frontmatterLines
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 1) {
      throw new Error(`Malformed Dolt front-matter line: ${line}`);
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (values.has(key)) {
      throw new Error(`Duplicate Dolt front-matter key: ${key}`);
    }
    values.set(key, value);
  }

  const requiredKeys = ["summary-type", "dates-covered", "finalized-at-reset"];
  const optionalKeys = new Set(["children"]);
  for (const key of requiredKeys) {
    if (!values.has(key)) {
      throw new Error(`Missing Dolt front-matter key: ${key}`);
    }
  }
  for (const key of values.keys()) {
    if (!requiredKeys.includes(key) && !optionalKeys.has(key)) {
      throw new Error(`Unsupported Dolt front-matter key: ${key}`);
    }
  }

  const summaryType = parseSummaryType(values.get("summary-type")!);
  const datesCovered = parseDatesCovered(values.get("dates-covered")!);
  const childrenValue = values.get("children");
  const children = typeof childrenValue === "string" ? parseChildrenList(childrenValue) : [];
  const finalizedAtReset = parseBoolean(values.get("finalized-at-reset")!, "finalized-at-reset");

  return normalizeFrontmatter({
    summaryType,
    datesCovered,
    children,
    finalizedAtReset,
  });
}

function parseSummaryType(value: string): DoltSummaryType {
  if (value === "leaf" || value === "bindle") {
    return value;
  }
  throw new Error(`Invalid summary-type: ${value}`);
}

function parseDatesCovered(value: string): { startEpochMs: number; endEpochMs: number } {
  const matched = /^(\d+)\|(\d+)$/.exec(value);
  if (!matched) {
    throw new Error(`Invalid dates-covered format: ${value}`);
  }
  const startEpochMs = requireEpochMs(Number(matched[1]), "dates-covered.startEpochMs");
  const endEpochMs = requireEpochMs(Number(matched[2]), "dates-covered.endEpochMs");
  if (endEpochMs < startEpochMs) {
    throw new Error(
      `Invalid dates-covered range: end ${endEpochMs} must be >= start ${startEpochMs}.`,
    );
  }
  return {
    startEpochMs,
    endEpochMs,
  };
}

function parseChildrenList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Invalid children list: ${value}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const children: string[] = [];
  let index = 0;
  while (index < inner.length) {
    while (index < inner.length && inner[index] === " ") {
      index += 1;
    }
    if (inner[index] !== "'") {
      throw new Error(`Children must use single-quoted pointers: ${value}`);
    }
    index += 1;
    let pointer = "";
    while (index < inner.length) {
      const char = inner[index];
      if (char === "'") {
        if (inner[index + 1] === "'") {
          pointer += "'";
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      pointer += char;
      index += 1;
    }
    children.push(requirePointer(pointer));

    while (index < inner.length && inner[index] === " ") {
      index += 1;
    }
    if (index >= inner.length) {
      break;
    }
    if (inner[index] !== ",") {
      throw new Error(`Invalid children separator in: ${value}`);
    }
    index += 1;
  }

  return children;
}

function parseBoolean(value: string, label: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid ${label} value: ${value}`);
}

function normalizeFrontmatter(frontmatter: DoltSummaryFrontmatter): DoltSummaryFrontmatter {
  const summaryType = parseSummaryType(frontmatter.summaryType);
  const startEpochMs = requireEpochMs(
    frontmatter.datesCovered.startEpochMs,
    "datesCovered.startEpochMs",
  );
  const endEpochMs = requireEpochMs(frontmatter.datesCovered.endEpochMs, "datesCovered.endEpochMs");
  if (endEpochMs < startEpochMs) {
    throw new Error(
      `Invalid datesCovered range: end ${endEpochMs} must be >= start ${startEpochMs}.`,
    );
  }
  const children = frontmatter.children.map((pointer) => requirePointer(pointer));
  if (typeof frontmatter.finalizedAtReset !== "boolean") {
    throw new Error("finalizedAtReset must be a boolean");
  }
  return {
    summaryType,
    datesCovered: {
      startEpochMs,
      endEpochMs,
    },
    children,
    finalizedAtReset: frontmatter.finalizedAtReset,
  };
}

function extractLeadingFrontmatter(source: string): {
  frontmatterLines: string;
  body: string;
} | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("---\n")) {
    return null;
  }

  const afterStart = trimmed.slice("---\n".length);
  const closeIndex = afterStart.indexOf("\n---");
  if (closeIndex === -1) {
    throw new Error("Dolt summary front-matter is missing a closing --- delimiter.");
  }

  const markerEnd = closeIndex + "\n---".length;
  const trailingChar = afterStart[markerEnd];
  if (trailingChar !== undefined && trailingChar !== "\n") {
    throw new Error("Dolt summary front-matter closing delimiter must end the line.");
  }

  const body = trailingChar === "\n" ? afterStart.slice(markerEnd + 1) : "";
  return {
    frontmatterLines: afterStart.slice(0, closeIndex),
    body,
  };
}

function expectedChildLevelForParent(parentLevel: DoltRecordLevel): DoltRecordLevel | null {
  if (parentLevel === "leaf") {
    return "turn";
  }
  if (parentLevel === "bindle") {
    return "leaf";
  }
  return null;
}

function requirePointer(value: string): string {
  if (typeof value !== "string") {
    throw new Error("children pointers must be strings");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("children pointers must be non-empty strings");
  }
  return trimmed;
}

function requireEpochMs(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function escapeYamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

export function isDoltRecordLevel(value: unknown): value is DoltRecordLevel {
  return typeof value === "string" && DOLT_RECORD_LEVELS.includes(value as DoltRecordLevel);
}
