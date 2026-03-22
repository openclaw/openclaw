import util from "node:util";
import { loggingState } from "./logging/state.js";
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
      // When console is captured and logs are routed to stderr (--json mode),
      // write directly to stdout so the JSON payload is not redirected.
      if (loggingState.forceConsoleToStderr && loggingState.consolePatched) {
        process.stdout.write(`${util.format(...args)}\n`);
        return;
      }
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

export function createNonExitingRuntime(): RuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}
