// GracefulShutdown coordinator — single exit point for the process.
// Replaces 31+ raw process.exit() calls.
// Drains active sessions, flushes state, kills child processes, then exits.

import { createRequire } from "node:module";

type ShutdownTask = () => void | Promise<void>;
type ShutdownPhase = "drain" | "flush" | "kill" | "exit";

const require = createRequire(import.meta.url);

let shuttingDown = false;
let shutdownExitCode = 0;
let shutdownTasks: ShutdownTask[] = [];
let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
const FORCE_EXIT_DELAY_MS = 5_000;

/** Registers a shutdown task run before process exit. */
export function onShutdown(task: ShutdownTask): void {
  shutdownTasks.push(task);
}

/** Runs all registered shutdown tasks in order, then exits with the given code. */
export function shutdown(exitCode = 0): void {
  if (shuttingDown) {
    // Force exit on second call (double-exit guard, matches TUI forceExit pattern)
    forceExit();
    return;
  }
  shuttingDown = true;
  shutdownExitCode = exitCode;

  // Force exit after timeout regardless (prevents hung shutdowns)
  forceExitTimer = setTimeout(() => {
    forceExit();
  }, FORCE_EXIT_DELAY_MS).unref();

  runShutdownTasks().finally(() => {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    process.exit(shutdownExitCode);
  });
}

/** Hard exit immediately, bypassing shutdown tasks. */
export function forceExit(): void {
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
  process.exit(shutdownExitCode || 130);
}

async function runShutdownTasks(): Promise<void> {
  const tasks = shutdownTasks;
  shutdownTasks = [];
  for (const task of tasks) {
    try {
      await task();
    } catch {
      // Swallow shutdown task errors; we are exiting anyway.
    }
  }
}

/** Convenience: schedule a delayed process exit (replaces setTimeout(() => process.exit(), N)). */
export function scheduleExit(exitCode = 0, delayMs = 0): void {
  setTimeout(() => {
    shutdown(exitCode);
  }, delayMs).unref();
}

/** Resets shutdown state (for testing). */
export function resetShutdownState(): void {
  shuttingDown = false;
  shutdownExitCode = 0;
  shutdownTasks = [];
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
}

/** Returns whether a shutdown is in progress. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}
