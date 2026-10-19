import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../../process/supervisor/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startComputerHostProcess } from "./computer-process.js";
import { ComputerHostFinalizationError, type ComputerHostInput } from "./computer-protocol.js";
import {
  computerCapabilities,
  observeSettlement as observe,
  runExit,
  whileHeld,
} from "./computer.test-support.js";

const computerUse = computerCapabilities({
  id: "fixture",
  label: "Fixture",
  generation: "native-generation",
});
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
  const activity = { resultSettled: false, lastOutputAtMs: 0 };
  const exit = (exitCode = 0) => {
    activity.resultSettled = true;
    exited.resolve(runExit({ exitCode, durationMs: 1 }));
  };
  const emit = (message: unknown) => inputs.at(-1)?.onStdout?.(`${JSON.stringify(message)}\n`);
  const run: ManagedRun = {
    runId: "synthetic-computer",
    startedAtMs: 0,
    activity,
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
    invoke: (overrides: Partial<Parameters<typeof child.invoke>[0]> = {}) =>
      child.invoke({
        command: "computer.act",
        params: { action: "left_click" },
        assertCurrent: () => {},
        ...overrides,
      }),
    async joinCleanup(observation: ReturnType<typeof observe>, beforeJoin?: () => Promise<void>) {
      await whileHeld(extinction, async () => {
        await beforeJoin?.();
        await cleanupStarted.promise;
        expect(observation.settled).not.toHaveBeenCalled();
      });
      await observation.done;
    },
  };
}

async function expectJoinedFailure(
  f: ReturnType<typeof createChildFixture>,
  beforeJoin?: () => Promise<void>,
) {
  const closing = f.child.close();
  const observed = observe(closing);
  const rejected = expect(closing).rejects.toBeInstanceOf(ComputerHostFinalizationError);
  await f.joinCleanup(observed, beforeJoin);
  await rejected;
  expect(f.child.isCurrent()).toBe(false);
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

    const result = f.invoke({
      command: "screen.snapshot",
      params: { executionId: "fixture" },
    });
    const invocation = await f.invocationReceived.promise;
    f.emit({
      type: "result",
      id: invocation.id,
      payload: JSON.stringify({ format: "png", base64: "cGl4ZWxz" }),
    });
    await expect(result).resolves.toEqual({ format: "png", base64: "cGl4ZWxz" });
    const close = child.close();
    const closing = observe(close);
    await f.stopReceived.promise;
    expect(child.isCurrent()).toBe(false);
    expect(closing.settled).not.toHaveBeenCalled();
    f.exit();
    await f.joinCleanup(closing);
    await close;
    expect(f.run.cancel).not.toHaveBeenCalled();
  });

  it.each(["malformed-envelope", "malformed-result-payload"])(
    "settles pending callers and joins cleanup after a %s",
    async (kind) => {
      const f = createChildFixture({ finalizationError: /Invalid Gateway computer response/ });
      const { child } = f;
      await child.ready;
      const result = f.invoke();
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

    await expectJoinedFailure(f, async () => {
      await f.cleanupStarted.promise;
      expect(f.cleanupScope).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["graceful exit", "idle exit", "fatal transport error"])(
    "preserves %s failure through joined finalization",
    async (failure) => {
      const graceful = failure === "graceful exit";
      const f = createChildFixture({
        finalizationError: graceful ? /shutdown failed/ : /process exited|fatal transport error/,
      });
      await f.child.ready;
      if (!graceful) {
        if (failure === "fatal transport error") {
          f.emit({ type: "error", message: failure });
        }
        f.exit(failure === "idle exit" ? 1 : 0);
        await f.cleanupStarted.promise;
        expect(f.child.isCurrent()).toBe(false);
      }
      await expectJoinedFailure(f, async () => {
        if (graceful) {
          await f.stopReceived.promise;
          f.exit(1);
        }
      });
    },
  );

  it("cancels an aborted invocation and joins native exit and descendant cleanup before rejecting", async () => {
    const f = createChildFixture();
    const { child } = f;
    await child.ready;
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const result = f.invoke({ signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);
    const observed = observe(result);
    const invocation = await f.invocationReceived.promise;
    controller.abort(reason);
    await f.stopReceived.promise;
    expect(f.messages).toContainEqual({ type: "cancel", id: invocation.id });
    expect(observed.settled).not.toHaveBeenCalled();
    f.exit();
    await f.joinCleanup(observed);
    await rejected;
    await expect(f.invoke({ command: "screen.snapshot", params: {} })).rejects.toThrow();
    expect(f.messages.filter((message) => message.type === "invoke")).toHaveLength(1);
  });
});
