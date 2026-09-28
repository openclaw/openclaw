import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import {
  createNodeHostClient,
  frame,
  holdInvoke,
  mocks,
  startRuntime,
} from "./runtime.test-support.js";

describe("node-host update pause", () => {
  it.each(["idle", "busy", "error", "plugin", "disconnect", "close"] as const)(
    "holds invoke admission through a delayed worker idle read ending in %s",
    async (outcome) => {
      const idle = createDeferred<boolean>();
      const cleanup = createDeferred();
      mocks.workerHasActiveWork.mockImplementationOnce(async () => await idle.promise);
      const request = vi.fn(async () => ({}));
      const runtime = await startRuntime(createNodeHostClient(request));
      const pausing = runtime.tryPauseForUpdate();
      const result =
        outcome === "error"
          ? expect(pausing).rejects.toThrow("journal unavailable")
          : expect(pausing).resolves.toBe(outcome === "idle");
      try {
        await runtime.invoke(frame);
        expect(mocks.handleInvoke).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledWith("node.invoke.result", {
          id: frame.id,
          nodeId: frame.nodeId,
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("updating") },
        });
        if (outcome === "plugin") {
          mocks.pluginHasActiveWork.mockReturnValue(true);
        } else if (outcome === "disconnect") {
          mocks.disconnectPlugins.mockImplementationOnce(async () => await cleanup.promise);
          runtime.cancelAll();
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
        if (outcome === "idle") {
          await runtime.invoke({ ...frame, id: "paused" });
          expect(mocks.handleInvoke).not.toHaveBeenCalled();
          runtime.resumeAfterUpdate();
        }
        await runtime.invoke({ ...frame, id: "after-check" });
        expect(mocks.handleInvoke).toHaveBeenCalledTimes(outcome === "close" ? 0 : 1);
      } finally {
        idle.resolve(false);
        cleanup.resolve();
        await Promise.allSettled([pausing]);
        await runtime.close();
      }
    },
  );

  it("does not let a resumed idle read release a replacement update pause", async () => {
    const first = createDeferred<boolean>();
    const second = createDeferred<boolean>();
    mocks.workerHasActiveWork
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => await second.promise);
    const runtime = await startRuntime();
    const original = runtime.tryPauseForUpdate();
    runtime.resumeAfterUpdate();
    const replacement = runtime.tryPauseForUpdate();
    try {
      first.resolve(false);
      expect(await original).toBe(false);
      await runtime.invoke(frame);
      expect(mocks.handleInvoke).not.toHaveBeenCalled();
      second.resolve(false);
      expect(await replacement).toBe(true);
      runtime.resumeAfterUpdate();
      await runtime.invoke(frame);
      expect(mocks.handleInvoke).toHaveBeenCalledOnce();
    } finally {
      first.resolve(false);
      second.resolve(false);
      await Promise.allSettled([original, replacement]);
      await runtime.close();
    }
  });

  it.each(["missing", "missing without disconnect", "undefined", "throwing", "declared"])(
    "requires an explicit plugin idle result after invocation with a %s hook",
    async (mode) => {
      const pluginBridge =
        await vi.importActual<typeof import("./plugin-node-host.js")>("./plugin-node-host.js");
      let retainedWork = false;
      let available = true;
      const onDisconnect = vi.fn(() => {
        retainedWork = false;
      });
      const hasActiveWork =
        mode === "undefined"
          ? vi.fn<() => boolean>()
          : mode === "throwing"
            ? () => {
                throw new Error("plugin work state unavailable");
              }
            : mode === "declared"
              ? () => retainedWork
              : undefined;
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands = [
        {
          pluginId: "legacy-work",
          pluginName: "Legacy work",
          source: "test",
          command: {
            command: "legacy.start",
            isAvailable: () => available,
            handle: async () => {
              retainedWork = true;
              return '{"workId":"background-1"}';
            },
            ...(mode === "missing without disconnect" ? {} : { onDisconnect }),
            ...(hasActiveWork ? { hasActiveWork } : {}),
          },
        },
      ];
      setActivePluginRegistry(registry);
      mocks.pluginHasActiveWork.mockImplementation(
        pluginBridge.hasRegisteredNodeHostCommandActiveWork,
      );
      mocks.handleInvoke.mockImplementationOnce(async () => {
        await pluginBridge.invokeRegisteredNodeHostCommand("legacy.start");
      });
      const runtime = await startRuntime();
      try {
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
      } finally {
        await runtime.close();
        resetPluginRuntimeStateForTest();
      }
    },
  );

  it.each(["system.run", "test.duplex", NODE_DESKTOP_STREAM_COMMAND])(
    "keeps %s busy from admission through disconnected command settlement",
    async (command) => {
      const held = holdInvoke();
      const request = vi.fn(async () => ({}));
      const runtime = await startRuntime(createNodeHostClient(request));
      const invoking = runtime.invoke({ ...frame, command });
      try {
        expect(await runtime.tryPauseForUpdate()).toBe(false);
        await vi.waitFor(() => expect(held.signal).toBeDefined());
        runtime.cancelAll();
        expect(held.signal?.aborted).toBe(true);
        expect(await runtime.tryPauseForUpdate()).toBe(false);

        held.release();
        await invoking;
        await vi.waitFor(async () => expect(await runtime.tryPauseForUpdate()).toBe(true));
        await runtime.invoke({ ...frame, id: "during-update", command });
        expect(mocks.handleInvoke).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith("node.invoke.result", {
          id: "during-update",
          nodeId: frame.nodeId,
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("updating") },
        });

        runtime.resumeAfterUpdate();
        await runtime.invoke({ ...frame, id: "after-update", command });
        expect(mocks.handleInvoke).toHaveBeenCalledTimes(2);
      } finally {
        held.release();
        await invoking;
        await runtime.close();
      }
    },
  );

  it("waits for superseded commands and buffered output after their replacements finish", async () => {
    const first = holdInvoke();
    const second = holdInvoke();
    const flushed = createDeferred();
    const runtime = await startRuntime();
    const original = runtime.invoke(frame);
    let replacement: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(first.signal).toBeDefined());
      replacement = runtime.invoke(frame);
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
    } finally {
      first.release();
      second.release();
      flushed.resolve();
      await Promise.allSettled([original, replacement]);
      await runtime.close();
    }
  });

  it("waits for plugin disconnect cleanup and retains a failed cleanup as busy", async () => {
    const cleanup = createDeferred();
    mocks.disconnectPlugins.mockImplementationOnce(async () => await cleanup.promise);
    const runtime = await startRuntime();
    try {
      runtime.cancelAll();
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      cleanup.reject(new Error("plugin process tree did not terminate"));
      await runtime.invoke(frame);
      expect(await runtime.tryPauseForUpdate()).toBe(false);

      runtime.cancelAll();
      await runtime.invoke(frame);
      expect(await runtime.tryPauseForUpdate()).toBe(true);
    } finally {
      cleanup.resolve();
      await runtime.close();
    }
  });

  it("waits for MCP startup and retained worker or plugin ownership before pausing", async () => {
    const startup = createDeferred<Awaited<ReturnType<typeof mocks.startMcp>>>();
    mocks.startMcp.mockImplementationOnce(async () => await startup.promise);
    const runtime = await startRuntime();
    try {
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      mocks.workerHasActiveWork.mockResolvedValue(true);
      startup.resolve({ descriptors: [], callMcpTool: vi.fn(), close: mocks.closeMcp });
      await runtime.invoke(frame);
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      mocks.workerHasActiveWork.mockResolvedValue(false);
      mocks.pluginHasActiveWork.mockReturnValue(true);
      expect(await runtime.tryPauseForUpdate()).toBe(false);
      mocks.pluginHasActiveWork.mockReturnValue(false);
      expect(await runtime.tryPauseForUpdate()).toBe(true);
    } finally {
      startup.resolve({ descriptors: [], callMcpTool: vi.fn(), close: mocks.closeMcp });
      await runtime.close();
    }
  });
});
