import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  withinTest,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { readCommandProcessFailure } from "../exec-result.js";
import { runCommandBuffersWithTimeout } from "../exec-runner.js";
import { withCommandProcessScope } from "../exec-spawn.js";
import { runCommandWithTimeout, runExec } from "../exec.js";
import { signalFixturePid } from "./broker-fixture.test-support.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

async function commandFixture(waitForAdmission = false) {
  const host = createSpawnBrokerHost();
  let remote: ReturnType<SpawnBrokerHost["spawnExeca"]> | undefined;
  onTestFinished(async () => {
    vi.useRealTimers();
    signalFixturePid(host.pid, "SIGCONT");
    if (remote) {
      if (waitForAdmission) {
        await withTestTimeout(remote.child.ready(), 5_000, "late readiness").catch(() => {});
      }
      remote.child.kill("SIGKILL");
      await remote.result.catch(() => {});
    }
    await host.close();
    vi.restoreAllMocks();
  });
  await host.ready();
  const spawnExeca = host.spawnExeca.bind(host);
  vi.spyOn(host, "spawnExeca").mockImplementation((...args) => {
    remote = spawnExeca(...args);
    return remote;
  });
  return { host, remote: () => remote! };
}

it.skipIf(skipBrokerTests).each([false, true])(
  "keeps one runExec deadline across admission and execution (cooperative exit: %s)",
  async (cooperative) => {
    const fixture = await commandFixture();
    const { host } = fixture;
    const source = `
        ${cooperative ? "process.on('SIGTERM',()=>{process.stdout.write('-stopped');process.exit(0)});" : ""}
        process.stdout.write('started');process.stderr.write('diagnostic');
        setInterval(()=>{},1000);
      `;
    const outputReady = Promise.withResolvers<void>();
    const output = { stdout: "", stderr: "" };
    process.kill(host.pid!, "SIGSTOP");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const command = runWithSpawnBroker(host, () =>
      runExec(process.execPath, ["-e", source], {
        timeoutMs: 2000,
        logOutput: false,
        onOutputChunk: (chunk, stream) => {
          output[stream] += chunk.toString();
          if (output.stdout === "started" && output.stderr === "diagnostic") {
            outputReady.resolve();
          }
        },
      }),
    );
    const outcome = command.catch((error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(900);
    expect(fixture.remote().child.pid).toBeUndefined();
    process.kill(host.pid!, "SIGCONT");
    await Promise.race([
      outputReady.promise,
      outcome.then(() => {
        throw new Error("command ended before output readiness");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1099);
    expect(fixture.remote().child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(fixture.remote().child.killed).toBe(true);
    expect(await outcome).toMatchObject({
      error: {
        timedOut: true,
        message: "Command timed out",
        shortMessage: "Command timed out",
        stdout: cooperative ? "started-stopped" : "started",
        stderr: "diagnostic",
        ...(cooperative ? { exitCode: 0 } : { signal: "SIGTERM" }),
      },
    });
    await fixture.remote().child.waitForClose();
    expect(isPidDefinitelyDead(fixture.remote().child.pid!)).toBe(true);
  },
);

const runnerResult = (termination: string) => ({ value: { termination, cleanup: "uncertain" } });
it.skipIf(skipBrokerTests).for([
  ["exec", "timeout", { error: { timedOut: true } }],
  ["exec", "signal", { error: { isCanceled: true } }],
  ["runner", "timeout", runnerResult("timeout")],
  ["runner", "signal", runnerResult("signal")],
  ["runner", "no-output-timeout", runnerResult("no-output-timeout")],
] as const)(
  "settles %s %s while the broker cannot complete startup",
  async ([api, reason, expected], { signal }) => {
    const fixture = await commandFixture(true);
    const { host } = fixture;
    const controller = new AbortController();
    const beforeInput = vi.fn();
    const args = ["-e", "setInterval(()=>{},1000)"];
    process.kill(host.pid!, "SIGSTOP");
    const command = runWithSpawnBroker(host, () =>
      api === "exec"
        ? runExec(process.execPath, args, {
            signal: controller.signal,
            timeoutMs: reason === "timeout" ? 50 : undefined,
            logOutput: false,
          })
        : runCommandWithTimeout([process.execPath, ...args], {
            signal: controller.signal,
            timeoutMs: reason === "timeout" ? 50 : undefined,
            noOutputTimeoutMs: reason === "no-output-timeout" ? 50 : undefined,
            killProcessTree: true,
            input: "not admitted",
            beforeInput,
          }),
    );
    if (reason === "signal") {
      controller.abort();
    }
    const outcome = await Promise.race([
      command.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      delay(500).then(() => ({ pending: true })),
    ]);
    expect(outcome).not.toHaveProperty("pending");
    expect(outcome).toMatchObject(expected);
    expect(beforeInput).not.toHaveBeenCalled();
    expect(fixture.remote()).toBeDefined();
    process.kill(host.pid!, "SIGCONT");
    await withinTest(fixture.remote().result, signal);
    await fixture.remote().child.waitForClose();
    expect(isPidDefinitelyDead(fixture.remote().child.pid!)).toBe(true);
    expect(beforeInput).not.toHaveBeenCalled();
  },
);

it
  .skipIf(skipBrokerTests || process.platform !== "linux")
  .for(["exit", "cancel", "timeout", "observer-error", "output-limit"] as const)(
  "preserves broker output during pending process identity preparation: %s",
  async (kind, { signal }) => {
    const fixture = await commandFixture();
    if (kind === "timeout") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const beforeInput = vi.fn();
    const scopeReleased = vi.fn();
    const observerError = new Error("output observer retired");
    let interruptObserver = false;
    let inner: ReturnType<typeof runCommandBuffersWithTimeout> | undefined;
    const observed = { stdout: "", stderr: "" };
    const transported = { stdout: "", stderr: "" };
    const expected = { stdout: "before-input stdout", stderr: "before-input stderr" };
    const readFile = fsp.readFile;
    let held = false;
    vi.spyOn(fsp, "readFile").mockImplementation(async (file, options) => {
      const value = await readFile(file, options);
      if (!held && file === `/proc/${fixture.remote()?.child.pid}/stat`) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return value;
    });
    const command = runWithSpawnBroker(fixture.host, () =>
      withCommandProcessScope(
        () =>
          (inner = runCommandBuffersWithTimeout(
            [
              process.execPath,
              "-e",
              "process.on('SIGUSR2',()=>process.stdout.write('-overflow'));process.stdout.write('before-input stdout');process.stderr.write('before-input stderr');process.stdin.resume()",
            ],
            {
              input: "owned input",
              beforeInput,
              timeoutMs: kind === "timeout" ? 2000 : undefined,
              outputCapture: "head",
              maxOutputBytes:
                kind === "output-limit" ? { stdout: expected.stdout.length } : undefined,
              terminateOnOutputLimit: kind === "output-limit" ? { stdout: true } : undefined,
              killProcessTree: true,
              requireProcessTreeExtinction: true,
              onOutputChunk: (chunk, stream) => {
                observed[stream] += chunk.toString();
                if (interruptObserver) {
                  throw observerError;
                }
              },
            },
          )),
        controller.signal,
      ),
    ).finally(scopeReleased);
    void inner?.catch(() => {});
    void command.catch(() => {});
    // Observe transport delivery independently; no synthetic output or wall-clock wait.
    const transportReady = fixture
      .remote()
      .child.ready()
      .then(() => {
        for (const stream of ["stdout", "stderr"] as const) {
          fixture.remote().child[stream]!.on("data", (chunk: Buffer) => {
            transported[stream] += chunk.toString();
            if (transported.stdout === expected.stdout && transported.stderr === expected.stderr) {
              delivered.resolve();
            }
          });
        }
      });
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([transportReady, entered.promise, delivered.promise]),
          command,
          "Command settled before delivering output during identity preparation",
        ),
        signal,
      );
      expect(beforeInput).not.toHaveBeenCalled();
      expect(observed).toEqual(expected);
      expect(inner).toBeDefined();
      if (kind === "exit") {
        resume.resolve();
      } else if (kind === "cancel") {
        controller.abort();
      } else if (kind === "timeout") {
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersToNextTimerAsync();
      } else {
        interruptObserver = kind === "observer-error";
        fixture.remote().child.kill("SIGUSR2");
      }
      const outcome = await withinTest(
        inner!.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
        signal,
      );
      if (kind === "observer-error") {
        expect(outcome).toEqual({ error: observerError });
        expect(
          readCommandProcessFailure("error" in outcome ? outcome.error : undefined)?.inputReleased,
        ).toBe(false);
      } else {
        if ("error" in outcome) {
          throw outcome.error;
        }
        const result = outcome.value;
        expect(result).toMatchObject({
          termination: kind === "exit" ? "exit" : kind === "timeout" ? "timeout" : "signal",
          cleanup: kind === "exit" ? "normal" : "uncertain",
          ...(kind === "exit" ? { code: 0 } : kind === "timeout" ? { code: 124 } : {}),
          ...(kind === "output-limit"
            ? { outputLimitExceeded: true, killIssuedByAbort: true, stdoutTruncatedBytes: 9 }
            : {}),
        });
        expect(result.stdout.toString()).toBe(expected.stdout);
        expect(result.stderr.toString()).toBe(expected.stderr);
      }
      if (kind !== "exit") {
        expect(scopeReleased).not.toHaveBeenCalled();
        expect(beforeInput).not.toHaveBeenCalled();
      }
      if (kind === "timeout") {
        await withinTest(fixture.remote().child.waitForClose(), signal);
        await vi.runOnlyPendingTimersAsync();
      }
      resume.resolve();
      await withinTest(
        command.catch(() => {}),
        signal,
      );
      expect(scopeReleased).toHaveBeenCalledOnce();
      expect(beforeInput).toHaveBeenCalledTimes(kind === "exit" ? 1 : 0);
    } finally {
      resume.resolve();
      controller.abort();
      if (vi.isFakeTimers()) {
        try {
          await withinTest(fixture.remote().child.waitForClose(), signal);
          await vi.runOnlyPendingTimersAsync();
        } finally {
          vi.useRealTimers();
        }
      }
      await withinTest(
        command.catch(() => {}),
        signal,
      );
    }
  },
);
