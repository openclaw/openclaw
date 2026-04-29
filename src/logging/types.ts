// 引入日志级别类型
import type { LogLevel } from "./levels.js";

// 控制台样式类型
export type ConsoleStyle = "pretty" | "compact" | "json";

// 日志器设置类型
export type LoggerSettings = {
  level?: LogLevel;          // 日志级别
  file?: string;             // 日志文件路径
  maxFileBytes?: number;     // 最大文件字节数
  consoleLevel?: LogLevel;   // 控制台日志级别
  consoleStyle?: ConsoleStyle; // 控制台样式
};
