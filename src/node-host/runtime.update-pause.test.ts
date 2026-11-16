import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createNodeHostClient,
  frame,
  holdInvoke,
  mocks,
  startRuntime,
} from "./runtime.test-support.js";

const runtimeCleanups: Array<() => Promise<void>> = [];
async function useRuntime(cleanup: () => void | Promise<unknown> = () => {}) {
  const request = vi.fn(async () => ({}));
  const runtime = await startRuntime(createNodeHostClient(request));
  runtimeCleanups.push(async () => {
    await cleanup();
    await runtime.close();
    resetPluginRuntimeStateForTest();
  });
  const expectUnavailable = (id = frame.id) =>
    expect(request).toHaveBeenCalledWith("node.invoke.result", {
      id,
      nodeId: frame.nodeId,
      ok: false,
      error: { code: "UNAVAILABLE", message: expect.stringContaining("updating") },
    });
  return { runtime, expectUnavailable };
}

describe("node-host update pause", () => {
  afterEach(async () => {
    for (const cleanup of runtimeCleanups.splice(0)) {
      await cleanup();
    }
  });
  it.each(["idle", "retirement", "busy", "error", "plugin", "disconnect", "close"] as const)(
    "holds invoke admission through the worker idle check and retirement ending in %s",
    async (outcome) => {
      const idle = createDeferred<boolean>();
      const cleanup = createDeferred();
      const entered = createDeferred();
      if (outcome === "retirement") {
        mocks.retireIdleWorkers.mockImplementationOnce(async () => {
          entered.resolve();
          await idle.promise;
        });
      } else {
        mocks.workerHasActiveWork.mockImplementationOnce(async () => await idle.promise);
      }
      let disconnecting: Promise<void> | undefined;
      const { runtime, expectUnavailable } = await useRuntime(() => {
        idle.resolve(false);
        cleanup.resolve();
      });
      const pausing = runtime.tryPauseForUpdate();
      const result =
        outcome === "error"
          ? expect(pausing).rejects.toThrow("journal unavailable")
          : expect(pausing).resolves.toBe(outcome === "idle" || outcome === "retirement");

      if (outcome === "retirement") {
        await entered.promise;
      }
      await runtime.invoke(frame);
      expect(mocks.handleInvoke).not.toHaveBeenCalled();
      expectUnavailable();
      if (outcome === "plugin") {
        mocks.pluginHasActiveWork.mockReturnValue(true);
      } else if (outcome === "disconnect") {
        mocks.disconnectPlugins.mockImplementationOnce(async () => await cleanup.promise);
        disconnecting = runtime.cancelAll();
      } else if (outcome === "close") {
        await runtime.close();
      }
      if (outcome === "error") {
        idle.reject(new Error("journal unavailable"));
      } else {
        idle.resolve(outcome === "busy");
      }
      await result;
      cleanup.resolve();
      await disconnecting;
      if (outcome === "retirement") {
        expect(mocks.retireIdleWorkers).toHaveBeenCalledOnce();
      }
      if (outcome === "idle" || outcome === "retirement") {
        await runtime.invoke({ ...frame, id: "paused" });
        expect(mocks.handleInvoke).not.toHaveBeenCalled();
        runtime.resumeAfterUpdate();
      }
      await runtime.invoke({ ...frame, id: "after-check" });
      expect(mocks.handleInvoke).toHaveBeenCalledTimes(outcome === "close" ? 0 : 1);
    },
  );

  it.each(["missing", "throwing", "declared"])(
    "requires an explicit plugin idle result after invocation with a %s hook",
    async (mode) => {
      const pluginBridge =
        await vi.importActual<typeof import("./plugin-node-host.js")>("./plugin-node-host.js");
      let retainedWork = false;
      let available = true;
      const onDisconnect = vi.fn(() => {
        retainedWork = false;
      });
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands.push({
        pluginId: "legacy-work",
        source: "test",
        command: {
          command: "legacy.start",
          isAvailable: () => available,
          handle: async () => {
            retainedWork = true;
            return "{}";
          },
          onDisconnect,
          ...(mode === "missing"
            ? {}
            : {
                hasActiveWork: () => {
                  if (mode === "throwing") {
                    throw new Error("plugin work state unavailable");
                  }
                  return retainedWork;
                },
              }),
        },
      });
      setActivePluginRegistry(registry);
      mocks.pluginHasActiveWork.mockImplementation(
        pluginBridge.hasRegisteredNodeHostCommandActiveWork,
      );
      mocks.handleInvoke.mockImplementationOnce(async () => {
        await pluginBridge.invokeRegisteredNodeHostCommand("legacy.start");
      });
      const { runtime } = await useRuntime();
      await runtime.invoke({ ...frame, command: "legacy.start" });
      expect(retainedWork).toBe(true);
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      available = false;
      expect(
        pluginBridge.listRegisteredNodeHostCapsAndCommands({ config: {}, env: {} }).commands,
      ).toEqual([]);
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      expect(onDisconnect).not.toHaveBeenCalled();

      retainedWork = false;
      expect(await runtime.tryPauseForUpdate()).toBe(mode === "declared");
    },
  );

  it("keeps an invocation busy from admission through disconnected command settlement", async () => {
    const held = holdInvoke();
    const { runtime, expectUnavailable } = await useRuntime(held.release);
    const invoking = runtime.invoke(frame);
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    await vi.waitFor(() => expect(held.signal).toBeDefined());
    await runtime.cancelAll();
    expect(held.signal?.aborted).toBe(true);
    expect(await runtime.tryPauseForUpdate()).toBe(false);

    held.release();
    await invoking;
    await vi.waitFor(async () => expect(await runtime.tryPauseForUpdate()).toBe(true));
    await runtime.invoke({ ...frame, id: "during-update" });
    expect(mocks.handleInvoke).toHaveBeenCalledOnce();
    expectUnavailable("during-update");

    runtime.resumeAfterUpdate();
    await runtime.invoke({ ...frame, id: "after-update" });
    expect(mocks.handleInvoke).toHaveBeenCalledTimes(2);
  });

  it("waits for superseded commands and buffered output after their replacements finish", async () => {
    const first = holdInvoke();
    const second = holdInvoke();
    const flushed = createDeferred();
    const { runtime } = await useRuntime(() => {
      first.release();
      second.release();
      flushed.resolve();
    });
    const original = runtime.invoke(frame);
    await vi.waitFor(() => expect(first.signal).toBeDefined());
    const replacement = runtime.invoke(frame);
    await vi.waitFor(() => expect(second.signal).toBeDefined());
    second.release();
    await replacement;
    expect(first.signal?.aborted).toBe(true);
    expect(await runtime.tryPauseForUpdate()).toBe(false);

    mocks.progressFlush.mockImplementationOnce(async () => await flushed.promise);
    first.release();
    await vi.waitFor(() => expect(mocks.progressFlush).toHaveBeenCalledTimes(2));
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    flushed.resolve();
    await original;
    expect(await runtime.tryPauseForUpdate()).toBe(true);
  });

  it("waits for plugin disconnect cleanup and retains a failed cleanup as busy", async () => {
    const cleanup = createDeferred();
    mocks.disconnectPlugins.mockImplementationOnce(async () => await cleanup.promise);
    const { runtime } = await useRuntime(() => cleanup.resolve());
    const disconnecting = expect(runtime.cancelAll()).rejects.toThrow(
      "plugin process tree did not terminate",
    );
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    cleanup.reject(new Error("plugin process tree did not terminate"));
    await disconnecting;
    await runtime.invoke(frame);
    expect(await runtime.tryPauseForUpdate()).toBe(false);

    await runtime.cancelAll();
    await runtime.invoke(frame);
    expect(await runtime.tryPauseForUpdate()).toBe(true);
  });

  it("waits for MCP startup and retained worker or plugin ownership before pausing", async () => {
    const startup = createDeferred<Awaited<ReturnType<typeof mocks.startMcp>>>();
    mocks.startMcp.mockImplementationOnce(async () => await startup.promise);
    const manager = { descriptors: [], callMcpTool: vi.fn(), close: mocks.closeMcp };
    const { runtime } = await useRuntime(() => startup.resolve(manager));
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    mocks.workerHasActiveWork.mockResolvedValue(true);
    startup.resolve(manager);
    await runtime.invoke(frame);
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    mocks.workerHasActiveWork.mockResolvedValue(false);
    mocks.pluginHasActiveWork.mockReturnValue(true);
    expect(await runtime.tryPauseForUpdate()).toBe(false);
    mocks.pluginHasActiveWork.mockReturnValue(false);
    expect(await runtime.tryPauseForUpdate()).toBe(true);
  });
});
