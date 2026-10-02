import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { restoreExecaResult } from "./execa-protocol.js";
import { startBrokerExeca } from "./execa-worker.js";

const boundary = vi.hoisted(() => ({ execa: vi.fn() }));
vi.mock("execa", () => ({ execa: boundary.execa }));

class CommandChild extends ChildProcess {
  override stdio: ChildProcess["stdio"] = [null, null, null, null, null];
  override exitCode: number | null = null;
  override signalCode: NodeJS.Signals | null = null;
}

function commandFixture() {
  const child = new CommandChild();
  const output = {
    stdout: "captured output",
    stderr: "",
    exitCode: 0,
    signal: undefined,
    failed: false,
    timedOut: false,
    isCanceled: false,
    isGracefullyCanceled: false,
    isMaxBuffer: false,
    isTerminated: false,
    isForcefullyTerminated: false,
    command: "synthetic-command",
    escapedCommand: "synthetic-command",
    cwd: "/synthetic",
    durationMs: 200,
  };
  const completion = createDeferredCore<typeof output>();
  const kill = vi.fn(() => true);
  boundary.execa.mockReturnValue(
    Object.assign(completion.promise, { nodeChildProcess: child, kill }),
  );
  const options = { executionDeadlineMs: 1_200, stdio: "ignore" as const };
  return { child, output, completion, kill, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  boundary.execa.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("broker execution deadline", () => {
  it.each(["cancel", "kill"] as const)(
    "preserves an earlier host %s while termination remains pending",
    async (action) => {
      const fixture = commandFixture();
      const run = await startBrokerExeca(["synthetic-command"], fixture.options, () => {});
      await vi.advanceTimersByTimeAsync(199);
      run[action]();
      await vi.advanceTimersByTimeAsync(1_002);
      expect(fixture.kill).toHaveBeenCalledTimes(action === "kill" ? 1 : 0);
      fixture.completion.reject(
        Object.assign(new Error("Command stopped"), fixture.output, {
          failed: true,
          isCanceled: action === "cancel",
        }),
      );
      expect(await run.result).toMatchObject({
        failed: true,
        timedOut: false,
        isCanceled: action === "cancel",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "stops an executing root while host delivery is stalled (cooperative exit: %s)",
    async (cooperative) => {
      const fixture = commandFixture();
      const run = await startBrokerExeca(["synthetic-command"], fixture.options, () => {});
      await vi.advanceTimersByTimeAsync(1_201);
      expect(fixture.kill).toHaveBeenCalledExactlyOnceWith();

      fixture.child.exitCode = cooperative ? 0 : null;
      fixture.child.signalCode = cooperative ? null : "SIGTERM";
      fixture.child.emit("exit", fixture.child.exitCode, fixture.child.signalCode);
      if (cooperative) {
        fixture.completion.resolve(fixture.output);
      } else {
        fixture.completion.reject(
          Object.assign(new Error("Command was killed"), fixture.output, {
            exitCode: undefined,
            signal: "SIGTERM",
            failed: true,
            isTerminated: true,
          }),
        );
      }
      const result = restoreExecaResult(await run.result);
      expect(result).toBeInstanceOf(Error);
      expect(result).toMatchObject({
        failed: true,
        timedOut: true,
        stdout: "captured output",
        exitCode: cooperative ? 0 : undefined,
        signal: cooperative ? undefined : "SIGTERM",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([false, true])(
    "preserves an exited root while output drain is stalled (exit event: %s)",
    async (emitExit) => {
      const fixture = commandFixture();
      const run = await startBrokerExeca(["synthetic-command"], fixture.options, () => {});
      await vi.advanceTimersByTimeAsync(199);
      fixture.child.exitCode = 0;
      if (emitExit) {
        fixture.child.emit("exit", 0, null);
      }
      // Keep Execa's result pending, as transferred output does until host drain completes.
      await vi.advanceTimersByTimeAsync(1_002);
      expect(fixture.kill).not.toHaveBeenCalled();
      fixture.completion.resolve(fixture.output);
      expect(await run.result).toMatchObject({
        exitCode: 0,
        failed: false,
        timedOut: false,
        stdout: "captured output",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
