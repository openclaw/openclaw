/**
 * Spool event-driven dispatch system.
 *
 * Spool complements cron (time-based) with event-based triggers.
 * Events are JSON files placed in ~/.openclaw/spool/events/ and processed
 * automatically by the gateway's file watcher.
 */

export * from "./types.js";
export * from "./schema.js";
export * from "./paths.js";
export * from "./reader.js";
export * from "./writer.js";
export * from "./dead-letter.js";
export * from "./dispatcher.js";
export * from "./watcher.js";
