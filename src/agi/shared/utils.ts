/**
 * OpenClaw AGI - Utilities
 *
 * Shared utility functions for all AGI modules.
 *
 * @module agi/shared/utils
 */

import { randomUUID, createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agi:utils");

// ============================================================================
// IDENTIFIERS
// ============================================================================

export function generateId(): string {
  return randomUUID();
}

export function generateShortId(length: number = 8): string {
  return randomUUID().replace(/-/g, "").substring(0, length);
}

// ============================================================================
// HASHING
// ============================================================================

export function computeChecksum(content: string): string {
  return createHash("md5").update(content).digest("hex").substring(0, 16);
}

export function computeHash(content: string, algorithm: "md5" | "sha256" = "sha256"): string {
  return createHash(algorithm).update(content).digest("hex");
}

// ============================================================================
// TIME
// ============================================================================

export function now(): Date {
  return new Date();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export function isExpired(date: Date, maxAgeMs: number): boolean {
  return Date.now() - date.getTime() > maxAgeMs;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

export function elapsedSince(start: Date): number {
  return Date.now() - start.getTime();
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// ============================================================================
// VALIDATION
// ============================================================================

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value) && value > 0;
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !isNaN(value.getTime());
}

export function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${name} to be defined`);
  }
  return value;
}

export function assertNonEmptyString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`Expected ${name} to be a non-empty string`);
  }
  return value;
}

// ============================================================================
// OBJECTS
// ============================================================================

export function pick<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

export function omit<T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================================
// ARRAYS
// ============================================================================

export function unique<T>(array: T[]): T[] {
  return [...new Set(array)];
}

export function groupBy<T, K extends string | number>(
  array: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of array) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

export function sortBy<T>(
  array: T[],
  keyFn: (item: T) => number | string | Date,
  direction: "asc" | "desc" = "asc",
): T[] {
  return [...array].toSorted((a, b) => {
    const aVal = keyFn(a);
    const bVal = keyFn(b);

    if (aVal < bVal) {
      return direction === "asc" ? -1 : 1;
    }
    if (aVal > bVal) {
      return direction === "asc" ? 1 : -1;
    }
    return 0;
  });
}

export function chunk<T>(array: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// ============================================================================
// STRINGS
// ============================================================================

export function truncate(str: string, maxLength: number, suffix = "..."): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - suffix.length) + suffix;
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

export interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  backoffFactor?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, delayMs, backoffFactor = 2, maxDelayMs = 30000 } = options;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === maxAttempts) {
        break;
      }

      log.warn(`Attempt ${attempt} failed, retrying in ${currentDelay}ms`, {
        detail: lastError.message,
      });
      await sleep(currentDelay);

      currentDelay = Math.min(currentDelay * backoffFactor, maxDelayMs);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// DEBOUNCE/THROTTLE
// ============================================================================

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | undefined;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => fn(...args), delayMs);
  };
}

export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let lastTime = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastTime >= delayMs) {
      lastTime = now;
      fn(...args);
    }
  };
}

// ============================================================================
// DEBUGGING
// ============================================================================

export function debugPrint(obj: unknown, label?: string): void {
  const output = label ? `${label}:` : "";
  console.log(output, JSON.stringify(obj, null, 2));
}

export function measureTime<T>(fn: () => T, label: string): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  log.debug(`${label} took ${elapsed.toFixed(2)}ms`);
  return result;
}

export async function measureTimeAsync<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  log.debug(`${label} took ${elapsed.toFixed(2)}ms`);
  return result;
}

// ============================================================================
// SANITIZATION
// ============================================================================

export function sanitizeString(input: string): string {
  return input
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/g, "") // Remove control characters
    .replace(/\\+/g, "\\") // Normalize backslashes
    .trim();
}

export function limitLength(input: string, maxLength: number): string {
  if (input.length <= maxLength) {
    return input;
  }
  return input.substring(0, maxLength);
}
