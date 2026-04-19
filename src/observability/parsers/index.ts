export { systemLogParser, parseSystemLogLine } from "./system-log.js";
export { cacheTraceParser, parseCacheTraceLine } from "./cache-trace.js";
export { sessionParser, parseSessionLine } from "./session.js";

/**
 * Source types for log ingestion.
 */
export type SourceType = "system-log" | "cache-trace" | "session";

/**
 * Parsed event ready for database insertion.
 */
export type ParsedEvent = {
  ts: string;
  sourceType: SourceType;
  sourceFile: string;
  eventType: string;
  level?: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  role?: string;
  messagePreview?: string;
  rawJson: string;
};

/**
 * Log parser interface for different log formats.
 */
export type LogParser = {
  sourceType: SourceType;
  parseLine: (line: string, sourceFile: string) => ParsedEvent | null;
};

import { cacheTraceParser } from "./cache-trace.js";
import { sessionParser } from "./session.js";
/**
 * Registry of available parsers by source type.
 */
import { systemLogParser } from "./system-log.js";

export const PARSERS: Record<SourceType, LogParser> = {
  "system-log": systemLogParser,
  "cache-trace": cacheTraceParser,
  session: sessionParser,
};

/**
 * Gets the appropriate parser for a source type.
 */
export function getParser(sourceType: SourceType): LogParser {
  const parser = PARSERS[sourceType];
  if (!parser) {
    throw new Error(`Unknown source type: ${sourceType}`);
  }
  return parser;
}

/**
 * Parses multiple lines using the specified parser.
 * Skips lines that fail to parse (returns null).
 */
export function parseLines(parser: LogParser, lines: string[], sourceFile: string): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const line of lines) {
    const event = parser.parseLine(line, sourceFile);
    if (event) {
      events.push(event);
    }
  }
  return events;
}
