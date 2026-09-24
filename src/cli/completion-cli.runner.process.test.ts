import * as childProcess from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
type Settlement =
  | { state: "pending" }
  | { state: "fulfilled" }
  | { state: "rejected"; error: unknown };

function observeSettlement(promise: Promise<unknown>) {
  const observed: { value: Settlement } = { value: { state: "pending" } };
  void promise.then(
    () => {
      observed.value = { state: "fulfilled" };
    },
    (error: unknown) => {
      observed.value = { state: "rejected", error };
    },
  );
  return observed;
}

it.skipIf(process.platform === "win32").each([
  {
    label: "exits before READY",
    script: "#!/bin/sh\nexit 23\n",
    outcome: { code: 23, signal: null },
    message: "code 23 signal null",
  },
  {
    label: "emits unexpected output before READY",
    script: `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdout.write("completion primary failure\\n");\n`,
    outcome: { code: null, signal: "SIGTERM" },
    message: "Unexpected PowerShell completion stdout: completion primary failure",
  },
  {
    label: "ignores termination after its first failure",
    script: `#!${process.execPath}
process.on("SIGTERM", () => process.stdout.write("completion fixture received SIGTERM\\n"));
setInterval(() => {}, 1000);
process.stdin.resume();
process.stdout.write("completion primary failure\\n");
`,
    outcome: { code: null, signal: "SIGKILL" },
    message: "Unexpected PowerShell completion stdout: completion primary failure",
  },
])(
  "rejects queued completions and preserves the first failure when a real child $label",
  async ({ script, outcome, message }) => {
    const tempDirs = createTempDirTracker();
    const children: Promise<ChildExit>[] = [];
    const liveChildren: childProcess.ChildProcess[] = [];
    let sentTermination = false;
    let childStdout = "";
    try {
      const executable = path.join(tempDirs.make("openclaw-completion-exit-"), "pwsh");
      writeFileSync(executable, script, { mode: 0o700 });
      const closed = createDeferred<ChildExit>();
      vi.resetModules();
      vi.stubEnv("OPENCLAW_TEST_PWSH", executable);
      vi.doMock("node:child_process", () => ({
        ...childProcess,
        spawn(...args: Parameters<typeof childProcess.spawn>) {
          const child = childProcess.spawn(...args);
          if (args[0] === executable) {
            liveChildren.push(child);
            const kill = child.kill.bind(child);
            vi.spyOn(child, "kill").mockImplementation((signal) => {
              const sent = kill(signal);
              if (signal === "SIGTERM" && sent) {
                sentTermination = true;
              }
              return sent;
            });
            if (!child.stdout || !child.stderr) {
              throw new Error("Completion fixture requires both output pipes");
            }
            child.stdout.on("data", (chunk: string | Buffer) => {
              childStdout += chunk.toString();
            });
            const exit = createDeferred<ChildExit>();
            child.once("close", (code, signal) => exit.resolve({ code, signal }));
            const drained = Promise.all([
              exit.promise,
              once(child.stdout, "end"),
              once(child.stderr, "end"),
            ]).then(([result]) => result);
            children.push(drained);
            void drained.then(closed.resolve, closed.reject);
          }
          return child;
        },
      }));
      const { PowerShellCompletionRunner } = await import("./completion-cli.test-support.js");
      const runner = new PowerShellCompletionRunner();
      const program = new Command().name("openclaw");
      const firstCompletion = runner.complete(program, "openclaw ");
      const first = observeSettlement(firstCompletion);
      const second = observeSettlement(runner.complete(program, "openclaw --"));
      const caller = observeSettlement(
        (async () => {
          try {
            await firstCompletion;
          } finally {
            await runner.close();
          }
        })(),
      );

      expect(await closed.promise).toEqual(outcome);
      // The real child is closed; only promise continuations remain.
      // Node drains those before setImmediate's check phase, regardless of chain depth.
      await setImmediate();
      const primaryFailure = expect.objectContaining({
        message: expect.stringContaining(message),
      });
      expect(first.value).toEqual({ state: "rejected", error: primaryFailure });
      expect(second.value).toEqual(first.value);
      expect(caller.value).toEqual(first.value);
      expect(children).toHaveLength(1);
      if (
        first.value.state !== "rejected" ||
        second.value.state !== "rejected" ||
        caller.value.state !== "rejected"
      ) {
        throw new Error("Completion and caller cleanup must reject");
      }
      expect(second.value.error).toBe(first.value.error);
      expect(caller.value.error).toBe(first.value.error);
      if (outcome.signal) {
        expect(sentTermination).toBe(true);
      }
      if (outcome.signal === "SIGKILL") {
        expect(childStdout).toContain("completion fixture received SIGTERM");
      }
    } finally {
      for (const child of liveChildren) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      // Real close and EOF, rather than the runner's exit latch, prove fixture completion.
      await Promise.all(children);
      vi.restoreAllMocks();
      vi.doUnmock("node:child_process");
      vi.unstubAllEnvs();
      vi.resetModules();
      tempDirs.cleanup();
    }
  },
);
