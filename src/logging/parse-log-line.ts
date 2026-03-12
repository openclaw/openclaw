import { extractActivityMetaFromUnknown } from "./activity/extract.js";
import type { ActivityMeta } from "./activity/types.js";

export type ParsedLogLine = {
  time?: string;
  level?: string;
  subsystem?: string;
  module?: string;
  message: string;
  activity?: ActivityMeta;
  raw: string;
};

function extractIndexedValues(
  value: Record<string, unknown>,
): Array<{ key: number; value: unknown }> {
  const entries: Array<{ key: number; value: unknown }> = [];
  for (const key of Object.keys(value)) {
    if (!/^\d+$/.test(key)) {
      continue;
    }
    entries.push({ key: Number(key), value: value[key] });
  }
  return entries.toSorted((a, b) => a.key - b.key);
}

function extractMessage(
  entries: Array<{ key: number; value: unknown }>,
  options?: { skipIndex?: number },
): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (options?.skipIndex != null && entry.key === options.skipIndex) {
      continue;
    }
    const item = entry.value;
    if (typeof item === "string") {
      parts.push(item);
    } else if (item != null) {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join(" ");
}

function parseMetaName(raw?: unknown): { subsystem?: string; module?: string } {
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      subsystem: typeof parsed.subsystem === "string" ? parsed.subsystem : undefined,
      module: typeof parsed.module === "string" ? parsed.module : undefined,
    };
  } catch {
    return {};
  }
}

export function parseLogLine(raw: string): ParsedLogLine | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const meta = parsed._meta as Record<string, unknown> | undefined;
    const nameMeta = parseMetaName(meta?.name);
    const levelRaw = typeof meta?.logLevelName === "string" ? meta.logLevelName : undefined;
    const indexed = extractIndexedValues(parsed);
    const indexedActivity = indexed
      .map((entry) => ({
        index: entry.key,
        activity: extractActivityMetaFromUnknown(entry.value),
      }))
      .find((entry) => Boolean(entry.activity));
    const topLevelActivity = extractActivityMetaFromUnknown(parsed.activity);
    const activity = topLevelActivity ?? indexedActivity?.activity;
    return {
      time:
        typeof parsed.time === "string"
          ? parsed.time
          : typeof meta?.date === "string"
            ? meta.date
            : undefined,
      level: levelRaw ? levelRaw.toLowerCase() : undefined,
      subsystem: nameMeta.subsystem,
      module: nameMeta.module,
      message: extractMessage(indexed, {
        skipIndex: topLevelActivity ? undefined : indexedActivity?.index,
      }),
      activity,
      raw,
    };
  } catch {
    return null;
  }
}
