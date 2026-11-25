import type { LogLevel } from "./levels.js";

export type ConsoleStyle = "pretty" | "compact" | "json";

/** User-configurable logger settings after config/env normalization. */
export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  maxFileBytes?: number;
  consoleLevel?: LogLevel;
  consoleStyle?: ConsoleStyle;
};
