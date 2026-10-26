import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withinTest, withTestTimeout } from "../../../test/helpers/promise.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
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

const execFileAsync = promisify(execFile);

async function openDescriptorCount(pid: number): Promise<number> {
  if (process.platform === "linux") {
    return (await readdir(`/proc/${pid}/fd`)).length;
  }
  const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-Ff"]);
  return stdout.split("\n").filter((line) => /^f\d+$/.test(line)).length;
}

async function runValidCommand(host: SpawnBrokerHost): Promise<void> {
  const child = host.spawn(process.execPath, ["-e", "process.stdout.write('ok')"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = child.waitForClose();
  await child.ready();
  let stdout = "";
  child.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  await closed;
  expect(stdout).toBe("ok");
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "spawn broker failed launch cleanup",
  () => {
    let host: SpawnBrokerHost;
    beforeEach(async () => {
      host = createSpawnBrokerHost();
      await host.ready();
      await runValidCommand(host);
    });
    afterEach(() => host.close());

    it.skipIf(!supportsSpawnBrokerCommandTransport())(
      "releases native descriptors after missing executable and cwd failures",
      async () => {
        const missing = path.join(tmpdir(), `openclaw-missing-spawn-${process.pid}`);
        const before = await openDescriptorCount(host.pid!);
        for (let attempt = 0; attempt < 24; attempt += 1) {
          const invalidCwd = attempt % 2 === 1;
          const child = host.spawn(invalidCwd ? process.execPath : missing, [], {
            ...(invalidCwd ? { cwd: missing } : {}),
            stdio: attempt % 4 < 2 ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
          });
          const closed = child.waitForClose();
          await expect(child.ready()).rejects.toMatchObject({ code: "ENOENT" });
          await closed;
        }
        await runValidCommand(host);
        expect(await openDescriptorCount(host.pid!)).toBe(before);
      },
    );

    it
      .skipIf(process.platform !== "linux" || !supportsSpawnBrokerCommandTransport())
      .each(["raw", "execa"] as const)(
      "preserves EMFILE and the broker after a streamless %s spawn failure",
      async (transport) => {
        const pid = host.pid;
        if (pid === undefined) {
          throw new Error("Ready spawn broker has no process identifier");
        }
        const before = await openDescriptorCount(pid);
        const limitArgs = [
          "--pid",
          String(pid),
          "--nofile",
          "--output",
          "SOFT,HARD",
          "--noheadings",
          "--raw",
        ];
        const { stdout: limits } = await execFileAsync("prlimit", limitArgs);
        const [soft, hard] = limits.trim().split(/\s+/);
        if (soft === undefined || hard === undefined) {
          throw new Error("prlimit did not report both descriptor limits");
        }
        await execFileAsync("prlimit", ["--pid", String(pid), "--nofile=3:"]);
        const { stdout: pressured } = await execFileAsync("prlimit", limitArgs);
        expect(pressured.trim().split(/\s+/)).toEqual(["3", hard]);
        // Unbuffered execa must reach Node's streamless EMFILE child itself.
        const args = ["-e", "process.exit(0)"];
        const run =
          transport === "execa"
            ? host.spawnExeca([process.execPath, ...args], {
                buffer: false,
                reject: false,
              })
            : undefined;
        const child =
          run?.child ??
          host.spawn(process.execPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
          });
        const closed = child.waitForClose();
        await expect(child.ready()).rejects.toMatchObject({ code: "EMFILE" });
        if (run) {
          // Execa reports early spawn failures as results when reject:false.
          await expect(run.result).resolves.toMatchObject({
            failed: true,
            code: "EMFILE",
            error: { code: "EMFILE" },
          });
        }
        await closed;
        expect(child.pid).toBeUndefined();
        await execFileAsync("prlimit", ["--pid", String(pid), `--nofile=${soft}:`]);
        const { stdout: restored } = await execFileAsync("prlimit", limitArgs);
        expect(restored.trim()).toBe(limits.trim());
        await runValidCommand(host);
        expect(host.pid).toBe(pid);
        expect(await openDescriptorCount(pid)).toBe(before);
      },
    );
  },
);
