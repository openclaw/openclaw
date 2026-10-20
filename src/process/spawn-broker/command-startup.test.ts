import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, withinTest, withTestTimeout } from "../../../test/helpers/promise.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { runCommandWithTimeout, runExec } from "../exec.js";
import { runWithSpawnBroker } from "./context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "./host.js";
import { supportsSpawnBrokerCommandTransport } from "./pipe.js";

const skipBrokerTests = !supportsSpawnBrokerCommandTransport();

async function commandFixture(waitForAdmission = false) {
  const host = createSpawnBrokerHost();
  let remote: ReturnType<SpawnBrokerHost["spawnExeca"]> | undefined;
  onTestFinished(async () => {
    vi.useRealTimers();
    try {
      process.kill(host.pid!, "SIGCONT");
    } catch {}
    if (remote) {
      if (waitForAdmission) {
        await withTestTimeout(
          remote.child.ready(),
          5_000,
          "late command did not reach readiness",
        ).catch(() => {});
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
  return {
    host,
    get remote() {
      return remote!;
    },
  };
}

describe.skipIf(skipBrokerTests)("command startup cancellation", () => {
  it.each([false, true])(
    "keeps one runExec deadline across admission and execution (cooperative exit: %s)",
    async (cooperative) => {
      const fixture = await commandFixture();
      const { host } = fixture;
      const source = `
        ${cooperative ? "process.on('SIGTERM',()=>{process.stdout.write('-stopped');process.exit(0)});" : ""}
        process.stdout.write('started');process.stderr.write('diagnostic');
        setInterval(()=>{},1000);
      `;
      const outputReady = createDeferred();
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
      const outcome = command.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(900);
      expect(fixture.remote.child.pid).toBeUndefined();
      process.kill(host.pid!, "SIGCONT");
      await Promise.race([
        outputReady.promise,
        outcome.then(() => {
          throw new Error("command ended before output readiness");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(1099);
      expect(fixture.remote.child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersToNextTimerAsync();
      expect(fixture.remote.child.killed).toBe(true);
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
      await fixture.remote.child.waitForClose();
      expect(isPidDefinitelyDead(fixture.remote.child.pid!)).toBe(true);
    },
  );

  it.for([
    { api: "exec", reason: "timeout" },
    { api: "exec", reason: "signal" },
    { api: "runner", reason: "timeout" },
    { api: "runner", reason: "signal" },
    { api: "runner", reason: "no-output-timeout" },
  ] as const)(
    "settles $api $reason while the broker cannot complete startup",
    async ({ api, reason }, { signal }) => {
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
      if (api === "exec") {
        expect(outcome).toMatchObject({
          error: reason === "timeout" ? { timedOut: true } : { isCanceled: true },
        });
      } else {
        expect(outcome).toMatchObject({ value: { termination: reason, cleanup: "uncertain" } });
      }
      expect(beforeInput).not.toHaveBeenCalled();
      expect(fixture.remote).toBeDefined();
      process.kill(host.pid!, "SIGCONT");
      await withinTest(fixture.remote.result, signal);
      await fixture.remote.child.waitForClose();
      expect(isPidDefinitelyDead(fixture.remote.child.pid!)).toBe(true);
      expect(beforeInput).not.toHaveBeenCalled();
    },
  );
});
