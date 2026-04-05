/**
 * 简单的日志工具
 * 
 * 在集成到 OpenClaw 核心后，可以替换为 OpenClaw 的日志系统：
 * import { createSubsystemLogger } from 'openclaw/logger';
 * const log = createSubsystemLogger('improvements');
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/**
 * 简单的日志类
 */
class Logger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix: string, level: LogLevel = LogLevel.INFO) {
    this.prefix = prefix;
    this.level = level;
  }

  /**
   * 设置日志级别
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * 调试日志
   */
  debug(...args: any[]): void {
    if (this.level <= LogLevel.DEBUG) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * 信息日志
   */
  info(...args: any[]): void {
    if (this.level <= LogLevel.INFO) {
      console.log(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * 警告日志
   */
  warn(...args: any[]): void {
    if (this.level <= LogLevel.WARN) {
      console.warn(`[${this.prefix}]`, ...args);
    }
  }

  /**
   * 错误日志
   */
  error(...args: any[]): void {
    if (this.level <= LogLevel.ERROR) {
      console.error(`[${this.prefix}]`, ...args);
    }
  }
}

/**
 * 创建日志记录器
 * 
 * @param prefix - 日志前缀
 * @param level - 日志级别
 */
export function createLogger(prefix: string, level?: LogLevel): Logger {
  return new Logger(prefix, level);
}

/**
 * 默认日志记录器
 */
export const log = createLogger('Improvements', LogLevel.INFO);

/**
 * 工具并发执行日志记录器
 */
export const concurrencyLog = createLogger('Concurrent', LogLevel.INFO);

/**
 * Microcompact 日志记录器
 */
export const microcompactLog = createLogger('Microcompact', LogLevel.INFO);

/**
 * Autocompact 日志记录器
 */
export const autocompactLog = createLogger('Autocompact', LogLevel.INFO);
