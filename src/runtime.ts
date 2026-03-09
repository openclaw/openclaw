import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";

export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

function createRuntimeIo(): Pick<RuntimeEnv, "log" | "error"> {
  return {
    log: (...args: Parameters<typeof console.log>) => {
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      clearActiveProgressLine();
      console.log(...args);
    },
    error: (...args: Parameters<typeof console.error>) => {
      clearActiveProgressLine();
      console.error(...args);
    },
  };
}

export const defaultRuntime: RuntimeEnv = {
  ...createRuntimeIo(),
  exit: (code) => {
    restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};

/**
 * Runtime that uses process._exit() to skip C++ atexit handlers.
 * Prevents GGML Metal assertion crashes during gateway shutdown where
 * ggml_metal_rsets_free races with a background init thread → ggml_abort.
 * Safe because the gateway completes all cleanup (server close, lock
 * release, signal removal) before calling exit.
 */
export function createGatewayRuntime(): RuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code) => {
      restoreTerminalState("gateway exit", { resumeStdinIfPaused: false });
      (process as unknown as { _exit: (code: number) => never })._exit(code);
    },
  };
}

export function createNonExitingRuntime(): RuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}
