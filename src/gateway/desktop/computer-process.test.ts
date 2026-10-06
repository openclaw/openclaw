import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startComputerHostProcess } from "./computer-process.js";
import { ComputerHostFinalizationError, type ComputerHostInput } from "./computer-protocol.js";

const computerUse: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture", label: "Fixture", generation: "native-generation" },
  actions: ["screenshot", "left_click"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function createChildFixture(options: { startupError?: string; finalizationError?: RegExp } = {}) {
  const exited = createDeferredCore<RunExit>();
  const extinction = createDeferredCore();
  const cleanupStarted = createDeferredCore();
  const stopReceived = createDeferredCore();
  const invocationReceived = createDeferredCore<Extract<ComputerHostInput, { type: "invoke" }>>();
  const messages: ComputerHostInput[] = [];
  const inputs: SpawnInput[] = [];
  let input: SpawnInput | undefined;
  let resultSettled = false;
  const exit = (exitCode = 0) => {
    resultSettled = true;
    exited.resolve({
      reason: "exit",
      exitCode,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    });
  };
  const emit = (message: unknown) => input?.onStdout?.(`${JSON.stringify(message)}\n`);
  const run: ManagedRun = {
    runId: "synthetic-computer",
    startedAtMs: 0,
    activity: {
      get resultSettled() {
        return resultSettled;
      },
      lastOutputAtMs: 0,
    },
    wait: () => exited.promise,
    cancel: vi.fn(() => exit()),
    stdin: {
      write(data, callback) {
        const message = JSON.parse(data.toString()) as ComputerHostInput;
        messages.push(message);
        if (message.type === "start") {
          emit(
            options.startupError
              ? { type: "error", message: options.startupError }
              : { type: "ready", computerUse },
          );
        }
        if (message.type === "invoke") {
          invocationReceived.resolve(message);
        }
        if (message.type === "stop") {
          stopReceived.resolve();
        }
        callback?.();
      },
      end() {},
    },
  };
  const cleanupScope = vi.fn(async () => {
    cleanupStarted.resolve();
    await extinction.promise;
  });
  const supervisor: ProcessSupervisor = {
    acquireScopeCleanup: () => cleanupScope,
    spawn: async (params) => {
      params.assertCurrent?.();
      input = params;
      inputs.push(params);
      return run;
    },
    cancel: () => run.cancel(),
    cancelScope: () => run.cancel(),
  };
  const env = {
    PATH: path.dirname(process.execPath),
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
  };
  const child = startComputerHostProcess({
    env,
    pluginIds: ["fixture"],
    assertCurrent: () => {},
    supervisor,
  });
  cleanups.push(async () => {
    exit();
    extinction.resolve();
    const closing = child.close();
    if (options.finalizationError) {
      await expect(closing).rejects.toThrow(options.finalizationError);
    } else {
      await closing;
    }
  });
  return {
    child,
    env,
    inputs,
    messages,
    emit,
    exit,
    extinction,
    cleanupStarted,
    cleanupScope,
    stopReceived,
    invocationReceived,
    run,
  };
}

describe("Gateway computer process", () => {
  it("carries the acquired desktop environment and selected provider into the child, then finalizes through its scope owner", async () => {
    const originalDisplay = process.env.DISPLAY;
    const originalBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const f = createChildFixture();
    const { child } = f;
    expect(f.inputs).toHaveLength(0);
    expect(await child.ready).toEqual(computerUse);
    expect(f.inputs[0]).toMatchObject({ env: f.env, exactEnv: true, stdinMode: "pipe-open" });
    expect(f.messages[0]).toEqual({ type: "start", pluginIds: ["fixture"] });
    expect(process.env.DISPLAY).toBe(originalDisplay);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(originalBus);

    const result = child.invoke({
      command: "screen.snapshot",
      params: { executionId: "fixture" },
      assertCurrent: () => {},
    });
    const invocation = await f.invocationReceived.promise;
    f.emit({
      type: "result",
      id: invocation.id,
      payload: JSON.stringify({ format: "png", base64: "cGl4ZWxz" }),
    });
    await expect(result).resolves.toEqual({ format: "png", base64: "cGl4ZWxz" });
    const settled = vi.fn();
    const closing = child.close().then(settled);
    await f.stopReceived.promise;
    expect(child.isCurrent()).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    f.exit();
    await f.cleanupStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    f.extinction.resolve();
    await closing;
    expect(f.run.cancel).not.toHaveBeenCalled();
  });

  it.each(["malformed-envelope", "malformed-result-payload"])(
    "settles pending callers and joins cleanup after a %s",
    async (kind) => {
      const f = createChildFixture({ finalizationError: /Invalid Gateway computer response/ });
      const { child } = f;
      await child.ready;
      const result = child.invoke({
        command: "computer.act",
        params: { action: "left_click" },
        assertCurrent: () => {},
      });
      const rejected = expect(result).rejects.toThrow("Invalid Gateway computer response");
      const invocation = await f.invocationReceived.promise;
      f.emit(
        kind === "malformed-envelope"
          ? { type: "not-a-message" }
          : { type: "result", id: invocation.id, payload: "{" },
      );
      await f.stopReceived.promise;
      expect(child.isCurrent()).toBe(false);
      f.exit();
      await f.cleanupStarted.promise;
      f.extinction.resolve();
      await rejected;
    },
  );

  it("reports a failed graceful exit only after joining descendant cleanup", async () => {
    const f = createChildFixture({ finalizationError: /shutdown failed/ });
    const { child } = f;
    await child.ready;
    const settled = vi.fn();
    const closing = child.close();
    const observed = closing.then(settled, settled);
    const rejected = expect(closing).rejects.toBeInstanceOf(ComputerHostFinalizationError);
    await f.stopReceived.promise;
    f.exit(1);
    await f.cleanupStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    f.extinction.resolve();
    await rejected;
    await observed;
    expect(child.isCurrent()).toBe(false);
  });

  it("retains the eager cleanup handle when startup and the first physical cleanup attempt fail", async () => {
    const f = createChildFixture({
      startupError: "synthetic provider startup failed",
      finalizationError: /synthetic provider startup failed/,
    });
    const joinFailure = new Error("descendant cleanup could not join");
    f.cleanupScope.mockRejectedValueOnce(joinFailure);
    expect(f.inputs).toHaveLength(0);
    await expect(f.child.ready).rejects.toThrow("synthetic provider startup failed");
    const firstClose = f.child.close();
    f.exit(1);
    await expect(firstClose).rejects.toBe(joinFailure);

    const settled = vi.fn();
    const retry = f.child.close();
    const observed = retry.then(settled, settled);
    const rejected = expect(retry).rejects.toBeInstanceOf(ComputerHostFinalizationError);
    await f.cleanupStarted.promise;
    try {
      expect(settled).not.toHaveBeenCalled();
      expect(f.cleanupScope).toHaveBeenCalledTimes(2);
    } finally {
      f.extinction.resolve();
    }
    await rejected;
    await observed;
  });

  it.each(["exit", "fatal transport error"])(
    "preserves an unexpected idle %s through joined finalization",
    async (failure) => {
      const f = createChildFixture({ finalizationError: /process exited|fatal transport error/ });
      await f.child.ready;
      if (failure === "exit") {
        f.exit(1);
      } else {
        f.emit({ type: "error", message: "fatal transport error" });
        f.exit();
      }
      await f.cleanupStarted.promise;
      const settled = vi.fn();
      const closing = f.child.close();
      const observed = closing.then(settled, settled);
      const rejected = expect(closing).rejects.toBeInstanceOf(ComputerHostFinalizationError);
      try {
        expect(f.child.isCurrent()).toBe(false);
        expect(settled).not.toHaveBeenCalled();
      } finally {
        f.extinction.resolve();
      }
      await rejected;
      await observed;
    },
  );

  it("cancels an aborted invocation and joins native exit and descendant cleanup before rejecting", async () => {
    const f = createChildFixture();
    const { child } = f;
    await child.ready;
    const controller = new AbortController();
    const settled = vi.fn();
    const reason = new Error("caller cancelled");
    const result = child.invoke({
      command: "computer.act",
      params: { action: "left_click" },
      signal: controller.signal,
      assertCurrent: () => {},
    });
    const rejected = expect(result).rejects.toBe(reason);
    const observed = result.then(settled, settled);
    const invocation = await f.invocationReceived.promise;
    controller.abort(reason);
    await f.stopReceived.promise;
    expect(f.messages).toContainEqual({ type: "cancel", id: invocation.id });
    expect(settled).not.toHaveBeenCalled();
    f.exit();
    await f.cleanupStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    f.extinction.resolve();
    await rejected;
    await observed;
    await expect(
      child.invoke({ command: "screen.snapshot", params: {}, assertCurrent: () => {} }),
    ).rejects.toThrow();
    expect(f.messages.filter((message) => message.type === "invoke")).toHaveLength(1);
  });
});
