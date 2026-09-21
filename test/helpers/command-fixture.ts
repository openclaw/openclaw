import type { ChildProcess } from "node:child_process";
import { finished as streamFinished } from "node:stream/promises";
import { it, type TestContext } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "./bounded-child-output.js";
import { createFixtureDiagnostics, type FixtureDiagnostics } from "./fixture-diagnostics.js";
import { createFixtureLifetime } from "./fixture-lifetime.js";

export function createCommandFixture(
  { signal, onTestFinished }: Pick<TestContext, "signal" | "onTestFinished">,
  completionMode: "close" | "tree" = "close",
) {
  const lifetime = createFixtureLifetime();
  const finished = new AbortController();
  const commandSignal = AbortSignal.any([signal, finished.signal]);
  const commands: Promise<unknown>[] = [];
  let diagnostics: FixtureDiagnostics | undefined;
  onTestFinished(async ({ task }) => {
    finished.abort();
    // Normal teardown also aborts finished; only the test result/original signal means failure.
    if (task.result?.state === "fail" || signal.aborted) {
      diagnostics?.report(signal.aborted ? "abort" : "failure");
    }
    await Promise.allSettled(commands);
  });

  function run(
    bin: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      encoding?: "utf8";
      input?: string;
      maxBuffer?: number;
    } = {},
  ) {
    commandSignal.throwIfAborted();
    const observation = diagnostics?.command("command", options.input !== undefined);
    const completion = (async () => {
      // Match spawnSync's bounded UTF-8 capture while the managed owner joins
      // the process group before this case can remove its filesystem inputs.
      const maxBuffer = options.maxBuffer ?? 1024 * 1024;
      const stdout = createBoundedChildOutput(maxBuffer);
      const stderr = createBoundedChildOutput(maxBuffer);
      const failed = new AbortController();
      let child: ChildProcess | undefined;
      let inputComplete: Promise<void> | undefined;
      let error: unknown;
      let bytes = 0;
      try {
        await runManagedCommand({
          bin,
          args,
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeout,
          signal: AbortSignal.any([commandSignal, failed.signal]),
          // Ordinary CLI completion includes inherited output drainage. Cancellation
          // still joins the group; Mac scripts retain their strict exit contract.
          requireProcessTreeExit: completionMode === "tree" && process.platform !== "win32",
          shell: false,
          stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          onReady(process) {
            child = process;
            if (options.input !== undefined) {
              inputComplete = streamFinished(process.stdin!, { cleanup: true }).catch(
                (cause: unknown) => {
                  error ??= cause;
                  failed.abort(cause);
                },
              );
              process.stdin!.end(options.input, "utf8");
            }
            for (const [name, pipe, output] of [
              ["stdout", process.stdout!, stdout],
              ["stderr", process.stderr!, stderr],
            ] as const) {
              pipe.on("data", (chunk: Buffer) => {
                output.append(chunk);
                bytes += chunk.byteLength;
                observation?.output(name, chunk.byteLength);
                if (bytes > maxBuffer && !failed.signal.aborted) {
                  error = Object.assign(new Error(`${name} maxBuffer length exceeded`), {
                    code: "ENOBUFS",
                  });
                  failed.abort(error);
                }
              });
            }
            observation?.ready(process);
          },
        });
      } catch (cause) {
        if (!error) {
          error = cause;
        } else if (!(cause instanceof Error && "code" in cause && cause.code === "ABORT_ERR")) {
          error = new AggregateError([error, cause], "Command failed", { cause });
        }
      } finally {
        observation?.settled(error);
        child?.stdin?.destroy();
        await inputComplete;
        observation?.inputComplete();
      }
      // Signal-boundary cases assert the native null status and exact signal.
      return {
        status: child?.exitCode ?? null,
        signal: child?.signalCode ?? null,
        error,
        stdout: stdout.text(),
        stderr: stderr.text(),
      };
    })();
    commands.push(completion);
    return lifetime.track(completion);
  }

  return {
    lifetime,
    createTempDir: lifetime.createTempDir,
    run,
    enableDiagnostics(name: string) {
      return (diagnostics ??= createFixtureDiagnostics(name));
    },
  };
}

export type CommandFixture = ReturnType<typeof createCommandFixture>;

export function createCommandTest() {
  const test = it.extend<{ command: CommandFixture }>({
    command: async ({ signal, onTestFinished }, use) => {
      await use(createCommandFixture({ signal, onTestFinished }));
    },
  });
  // Abort commands through onTestFinished before joining whole bodies and removing inputs.
  test.aroundEach(async (runTest, { command }) => {
    try {
      await runTest();
    } finally {
      await command.lifetime.cleanup();
    }
  });
  return test;
}
