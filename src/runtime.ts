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

export function createNonExitingRuntime(): RuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}
