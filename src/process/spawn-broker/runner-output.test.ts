import { Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import * as childTree from "../child-process-tree.js";
import * as commandIdentity from "../command-process-identity.js";
import { withCommandProcessScope } from "../exec-spawn.js";
import { runCommandWithTimeout, runExec } from "../exec.js";
import {
  createBrokerCommands,
  createBrokerCommandRequest,
  receiveBrokerCommandResponse,
  type BrokerCommandRequest,
} from "./commands.js";

const transport = vi.hoisted(() => ({
  current: undefined as ReturnType<typeof createBrokerCommands> | undefined,
}));
vi.mock("./context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.js")>()),
  getSpawnBroker: () => transport.current,
}));

afterEach(() => {
  transport.current = undefined;
  vi.useRealTimers();
});

// Replace only IPC delivery: the command adapter, request, BrokerChild, held
// Socket readers, readiness release, and runner remain their production owners.
function brokerFixture() {
  let request: BrokerCommandRequest;
  const pipes = [0, 1, 2].map(() => new Socket());
  for (const pipe of pipes) {
    pipe.once("end", () => pipe.destroy());
  }
  const transmit = async () => {};
  const receive = (message: Parameters<typeof receiveBrokerCommandResponse>[1], handle?: Socket) =>
    receiveBrokerCommandResponse(request, message, handle, transmit);
  const finish = (output: { stdout?: Uint8Array; stderr?: Uint8Array } = {}) => {
    void receive({ type: "exit", id: 1, code: 0, signal: null });
    pipes[1]!.push(null);
    pipes[2]!.push(null);
    void receive({
      type: "execa-result",
      id: 1,
      result: {
        exitCode: 0,
        failed: false,
        timedOut: false,
        isCanceled: false,
        isGracefullyCanceled: false,
        isMaxBuffer: false,
        isTerminated: false,
        isForcefullyTerminated: false,
        command: "fixture",
        escapedCommand: "fixture",
        cwd: process.cwd(),
        durationMs: 0,
        ...output,
      },
    });
  };
  transport.current = createBrokerCommands({
    nextId: () => 1,
    admit: (message, initiate) => {
      request = createBrokerCommandRequest(message, initiate, transmit);
      return request;
    },
    cancel: async () => finish(),
  });
  return {
    async attach() {
      // Startup has already returned a BrokerChild with null output handles.
      expect(request.child.stdout).toBeNull();
      await nextTurn();
      for (const [fd, pipe] of pipes.entries()) {
        // Output uses real held Socket readers; stdin is already closed.
        await receive({ type: "pipe", id: 1, fd, ...(fd === 0 ? { closed: true } : {}) }, pipe);
      }
      void receive({
        type: "spawned",
        id: 1,
        pid: 424242,
        spawnfile: "fixture",
        spawnargs: ["fixture"],
        connected: false,
        stdioLength: 3,
      });
      await request.child.ready();
      // BrokerChild itself releases held pipes after its readiness continuations.
      await nextTurn();
      await nextTurn();
    },
    output(stdout: string, stderr: string) {
      if (stdout) {
        pipes[1]!.push(Buffer.from(stdout));
      }
      if (stderr) {
        pipes[2]!.push(Buffer.from(stderr));
      }
    },
    finish,
    failOutput(stream: "stdout" | "stderr", error: Error) {
      pipes[stream === "stdout" ? 1 : 2]!.destroy(error);
    },
    async close() {
      finish();
      await request.child.waitForClose();
    },
  };
}

it.for(["capture", "cap", "observer-stop", "observer-error"] as const)(
  "subscribes after broker pipe attachment: %s",
  async (mode, { signal }) => {
    const fixture = brokerFixture();
    const observed = { stdout: "", stderr: "" };
    const observerError = new Error("broker observer failed");
    const command = runCommandWithTimeout(["fixture"], {
      timeoutMs: 5_000,
      ...(mode === "cap" ? { maxOutputBytes: 4, terminateOnOutputLimit: true } : {}),
      onOutputChunk: (chunk, stream) => {
        observed[stream] += chunk.toString();
        if (mode === "observer-stop") {
          return false;
        }
        if (mode === "observer-error") {
          throw observerError;
        }
        return undefined;
      },
    });
    void command.catch(() => {});
    try {
      // Queue bytes before attachment/readiness, as a transferred pipe prefix.
      fixture.output("early stdout", "early stderr");
      await fixture.attach();
      fixture.finish();
      if (mode === "observer-error") {
        await expect(withinTest(command, signal)).rejects.toBe(observerError);
      } else {
        expect(await withinTest(command, signal)).toMatchObject({
          stdout: mode === "cap" ? "dout" : "early stdout",
          stderr: mode === "cap" ? "derr" : "early stderr",
          ...(mode === "capture" ? { code: 0 } : { outputLimitExceeded: true }),
        });
      }
      if (mode === "capture") {
        expect(observed).toEqual({ stdout: "early stdout", stderr: "early stderr" });
      } else {
        expect(observed.stdout + observed.stderr).not.toBe("");
      }
    } finally {
      await fixture.close();
      await command.catch(() => {});
    }
  },
);

it("refreshes the no-output deadline from broker stdout and stderr", async ({ signal }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const fixture = brokerFixture();
  const command = runCommandWithTimeout(["fixture"], { noOutputTimeoutMs: 100 });
  try {
    await fixture.attach();
    await vi.advanceTimersByTimeAsync(75);
    fixture.output("tick", "");
    await vi.advanceTimersByTimeAsync(75);
    fixture.output("", "tock");
    await vi.advanceTimersByTimeAsync(75);
    fixture.finish();
    expect(await withinTest(command, signal)).toMatchObject({
      code: 0,
      termination: "exit",
      noOutputTimedOut: false,
      stdout: "tick",
      stderr: "tock",
    });
  } finally {
    await fixture.close();
    await command.catch(() => {});
  }
});

it.runIf(process.platform !== "win32")(
  "drains broker output while custody still withholds guarded input",
  async ({ signal }) => {
    const fixture = brokerFixture();
    const admission = Promise.withResolvers<null>();
    const identity = vi
      .spyOn(commandIdentity, "readCommandProcessStartTime")
      .mockReturnValue(admission.promise);
    const census = vi.spyOn(childTree, "isChildProcessTreeAliveAsync").mockResolvedValue(false);
    // The synthetic PID is never permission to send a real process signal.
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Synthetic broker PID cannot authorize native signals");
    });
    const bound = vi.fn();
    const settled = vi.fn();
    const refusal = new Error("input refused after custody");
    const beforeInput = vi.fn(() => {
      throw refusal;
    });
    const observed = { stdout: "", stderr: "" };
    const work = withCommandProcessScope(
      () =>
        runCommandWithTimeout(["fixture"], {
          input: "withheld",
          beforeInput,
          timeoutMs: 5_000,
          onOutputChunk: (chunk, stream) => {
            observed[stream] += chunk.toString();
          },
        }),
      undefined,
      { reserve: () => ({ spawned: bound, settled }) },
    );
    void work.catch(() => {});
    try {
      fixture.output("early stdout", "early stderr");
      await fixture.attach();
      expect(observed).toEqual({ stdout: "early stdout", stderr: "early stderr" });
      expect(bound).not.toHaveBeenCalled();
      expect(beforeInput).not.toHaveBeenCalled();
      fixture.finish();
      admission.resolve(null);
      await expect(withinTest(work, signal)).rejects.toBe(refusal);
      expect(bound).toHaveBeenCalledOnce();
      expect(beforeInput).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledOnce();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fixture.finish();
      admission.resolve(null);
      await work.catch(() => {});
      await fixture.close();
      kill.mockRestore();
      census.mockRestore();
      identity.mockRestore();
    }
  },
);

it.for(["stdout", "stderr"] as const)(
  "handles broker %s errors after attachment",
  async (stream, { signal }) => {
    const fixture = brokerFixture();
    const failure = new Error("broker output failed");
    const command = runCommandWithTimeout(["fixture"], { terminateOnOutputError: true });
    void command.catch(() => {});
    try {
      await fixture.attach();
      fixture.failOutput(stream, failure);
      await expect(withinTest(command, signal)).rejects.toBe(failure);
      expect(failure).toHaveProperty("outputErrorStream", stream);
    } finally {
      await fixture.close();
      await command.catch(() => {});
    }
  },
);

it("keeps late broker readiness cleanup after missing-PID cancellation", async ({ signal }) => {
  const fixture = brokerFixture();
  const controller = new AbortController();
  const beforeInput = vi.fn();
  const command = runCommandWithTimeout(["fixture"], {
    input: "withheld",
    beforeInput,
    signal: controller.signal,
  });
  try {
    controller.abort();
    expect(await withinTest(command, signal)).toMatchObject({
      termination: "signal",
      cleanup: "uncertain",
      stdout: "",
      stderr: "",
    });
    await fixture.attach();
    await fixture.close();
    expect(beforeInput).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
    await command.catch(() => {});
  }
});

it
  .runIf(process.platform !== "win32")
  .for(["observe", "throw", "cancel", "cancel-observer", "timeout"] as const)(
  "runExec observes broker output independently of pending custody: %s",
  async (mode, { signal }) => {
    if (mode === "timeout") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const fixture = brokerFixture();
    const admission = Promise.withResolvers<null>();
    const identity = vi
      .spyOn(commandIdentity, "readCommandProcessStartTime")
      .mockReturnValue(admission.promise);
    const census = vi.spyOn(childTree, "isChildProcessTreeAliveAsync").mockResolvedValue(false);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("Synthetic broker PID cannot authorize native signals");
    });
    const controller = new AbortController();
    const observed = { stdout: "", stderr: "" };
    const observer = vi.fn((chunk: Buffer, stream: "stdout" | "stderr") => {
      observed[stream] += chunk.toString();
      if (mode === "cancel-observer") {
        controller.abort();
      }
      if (mode === "throw") {
        throw new Error("diagnostic unavailable");
      }
    });
    const bound = vi.fn();
    let command!: ReturnType<typeof runExec>;
    const work = withCommandProcessScope(
      () => {
        command = runExec("fixture", [], {
          timeoutMs: mode === "timeout" ? 100 : 5_000,
          logOutput: false,
          signal: controller.signal,
          onOutputChunk: observer,
        });
        return command;
      },
      undefined,
      { reserve: () => ({ spawned: bound, settled: vi.fn() }) },
    );
    void command.catch(() => {});
    void work.catch(() => {});
    try {
      fixture.output("early stdout", "early stderr");
      if (mode === "cancel") {
        controller.abort();
      } else if (mode === "timeout") {
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersToNextTimerAsync();
      }
      if (mode === "cancel" || mode === "timeout") {
        await expect(withinTest(command, signal)).rejects.toMatchObject({
          [mode === "cancel" ? "isCanceled" : "timedOut"]: true,
          cleanup: "uncertain",
        });
      }
      await fixture.attach();
      expect(bound).not.toHaveBeenCalled();
      if (mode === "observe") {
        expect(observed).toEqual({ stdout: "early stdout", stderr: "early stderr" });
      } else if (mode === "throw" || mode === "cancel-observer") {
        expect(observer).toHaveBeenCalledOnce();
      } else {
        expect(observer).not.toHaveBeenCalled();
      }
      fixture.finish({ stdout: Buffer.from("early stdout"), stderr: Buffer.from("early stderr") });
      admission.resolve(null);
      if (mode === "observe" || mode === "throw") {
        expect(await withinTest(work, signal)).toEqual({
          stdout: "early stdout",
          stderr: "early stderr",
        });
      } else {
        await expect(withinTest(command, signal)).rejects.toMatchObject({
          [mode === "timeout" ? "timedOut" : "isCanceled"]: true,
        });
        await work.catch(() => {});
        expect(observer).toHaveBeenCalledTimes(mode === "cancel-observer" ? 1 : 0);
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      fixture.finish();
      admission.resolve(null);
      await work.catch(() => {});
      await fixture.close();
      kill.mockRestore();
      census.mockRestore();
      identity.mockRestore();
    }
  },
);
