// V8 compiler tiering for OpenClaw process entrypoints that end in process.exit().
import { setFlagsFromString } from "node:v8";

// process.exit() joins V8's platform workers without disposing the isolate. A
// concurrent Maglev or Sparkplug job parked waiting for a main-thread GC then
// never finishes, so the process hangs after its output (nodejs/node#64274;
// fix pending in nodejs/node#66171). Node 22 ran without both; switch them off
// before commands start compiling hot code. An explicit operator flag wins.
const EXIT_UNSAFE_COMPILERS = [
  { disable: "--no-maglev", enable: "--maglev" },
  { disable: "--no-concurrent-sparkplug", enable: "--concurrent-sparkplug" },
] as const;

/** Keeps V8 compile jobs that can deadlock process.exit() off background threads. */
export function disableExitUnsafeCompilers(): void {
  if (process.versions.bun) {
    return;
  }
  const explicit = new Set(process.execArgv.map((arg) => arg.replaceAll("_", "-")));
  for (const { disable, enable } of EXIT_UNSAFE_COMPILERS) {
    if (!explicit.has(enable)) {
      setFlagsFromString(disable);
    }
  }
}
