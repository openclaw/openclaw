import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

export function createSyntheticChild(
  output: "none" | "stdout" | "both" = "none",
  initialExit: number | null = null,
) {
  const child = new ChildProcess();
  let exitCode = initialExit;
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { get: () => exitCode },
    stdout: { value: output === "none" ? null : new PassThrough(), writable: true },
    stderr: { value: output === "both" ? new PassThrough() : null, writable: true },
    stdio: { get: () => [child.stdin, child.stdout, child.stderr, null] },
  });
  const exit = () => {
    exitCode = 0;
    child.emit("exit", 0, null);
  };
  return {
    child,
    exit,
    close: () => {
      exit();
      child.emit("close", 0, null);
    },
  };
}

export function runFixtureCommand(options: Omit<Parameters<typeof runManagedCommand>[0], "bin">) {
  return runManagedCommand({
    bin: "fixture",
    shell: false,
    stdio: "ignore",
    // Synthetic children own no filesystem resources unless a case supplies a root.
    env: { TMPDIR: process.cwd() },
    ...options,
  });
}
