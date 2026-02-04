import { clearActiveProgressLine } from "./terminal/progress-line.js";
<<<<<<< HEAD
=======
import { restoreTerminalState } from "./terminal/restore.js";
>>>>>>> upstream/main

export type RuntimeEnv = {
  log: typeof console.log;
  error: typeof console.error;
  exit: (code: number) => never;
};

export const defaultRuntime: RuntimeEnv = {
  log: (...args: Parameters<typeof console.log>) => {
    clearActiveProgressLine();
    console.log(...args);
  },
  error: (...args: Parameters<typeof console.error>) => {
    clearActiveProgressLine();
    console.error(...args);
  },
  exit: (code) => {
<<<<<<< HEAD
=======
    restoreTerminalState("runtime exit");
>>>>>>> upstream/main
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};
