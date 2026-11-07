import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../infra/node-commands.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../plugins/computer-use-registration.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeHostClient } from "./client.js";
import { prepareNodeHostRuntime } from "./runtime.js";

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(async () => ({ descriptors: [], close: async () => {} })),
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: () => getActivePluginRegistry(),
}));

afterEach(() => resetPluginRuntimeStateForTest());

const executionId = "123e4567-e89b-42d3-a456-426614174000";
const otherExecutionId = "223e4567-e89b-42d3-a456-426614174000";
const descriptor: ComputerUseCapabilityDescriptor = {
  contractVersion: 2,
  provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
  actions: ["screenshot", "type"],
  targets: ["screen"],
  deliveryModes: ["foreground"],
  observations: ["image"],
  features: { recording: false, agentCursor: false, multiDisplay: false },
};

async function startComputer(
  ephemeral = true,
  prepare?: () => Promise<void>,
  sharedPrepare = false,
) {
  let providerGeneration = descriptor.provider.generation;
  const snapshot = vi.fn(async (_params: unknown, _signal?: AbortSignal) =>
    JSON.stringify({ format: "png", base64: "c2NyZWVu", displayFrameId: "frame-1" }),
  );
  const act = vi.fn(async (_params: unknown, _signal?: AbortSignal) =>
    JSON.stringify({ ok: true }),
  );
  const close = vi.fn(async (_reason: string) => {});
  const stopWatching = vi.fn<() => Promise<void>>(async () => {});
  const watchComputer = vi.fn(() => stopWatching);
  const watchStatus = vi.fn(() => async () => {});
  const openExecution = vi.fn(async (_context: unknown) => ({ snapshot, act, close }));
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "fixture", enabled: true, status: "loaded" }));
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) =>
        registry.nodeHostCommands.push({ pluginId: "fixture", command, source: "test" }),
    },
    {
      id: "fixture",
      label: "Fixture",
      isAvailable: () => true,
      prepare,
      capabilities: () => ({
        ...descriptor,
        provider: { ...descriptor.provider, generation: providerGeneration },
      }),
      openExecution,
      watchAvailability: watchComputer,
    },
  );
  const disconnect = vi.fn(async () => {});
  registry.nodeHostCommands.push({
    pluginId: "fixture",
    source: "test",
    command: {
      command: "fixture.status",
      handle: async () => "{}",
      hasActiveWork: () => false,
      onDisconnect: disconnect,
      watchAvailability: watchStatus,
      ...(sharedPrepare ? { prepare: registry.nodeHostCommands[0]!.command.prepare } : {}),
    },
  });
  setActivePluginRegistry(registry);
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { skills: { enabled: false } } },
    env: { PATH: "/usr/bin" },
    ephemeral,
  });
  const requests: Array<Parameters<NodeHostClient["request"]>> = [];
  function request<T>(...args: Parameters<NodeHostClient["request"]>): Promise<T>;
  async function request(...args: Parameters<NodeHostClient["request"]>): Promise<unknown> {
    requests.push(args);
    return {};
  }
  const runtime = prepared.start({ client: { request }, onManifestChanged: vi.fn() });
  let invokeId = 0;
  const invoke = async (input: unknown, command = NODE_WORKER_DESKTOP_COMPUTER_COMMAND) => {
    const id = `invoke-${++invokeId}`;
    await runtime.invoke({
      id,
      nodeId: "cloud-node",
      sessionKey: "agent:main:cloud-session",
      command,
      paramsJSON: JSON.stringify(input),
    });
    const result = requests.find(
      (call) => call[0] === "node.invoke.result" && (call[1] as { id?: string }).id === id,
    )?.[1] as { ok: boolean; payloadJSON?: string; error?: { code: string; message: string } };
    return { ...result, payload: result?.payloadJSON ? JSON.parse(result.payloadJSON) : undefined };
  };
  return {
    prepared,
    runtime,
    invoke,
    snapshot,
    act,
    close,
    stopWatching,
    watchComputer,
    watchStatus,
    disconnect,
    openExecution,
    setProviderGeneration(value: string) {
      providerGeneration = value;
    },
  };
}

function computerOperation(
  operation: "snapshot" | "act",
  id = executionId,
  generation = descriptor.provider.generation,
) {
  return {
    operation,
    providerGeneration: generation,
    params: {
      executionId: id,
      ...(operation === "act" ? { action: "type", text: "fixture" } : {}),
    },
  };
}

async function withComputer(
  run: (host: Awaited<ReturnType<typeof startComputer>>) => Promise<void>,
  ephemeral = true,
) {
  const host = await startComputer(ephemeral);
  try {
    await run(host);
  } finally {
    await host.runtime.close();
  }
}

describe("private worker computer runtime", () => {
  it.each([
    { ephemeral: true, shared: false, fail: false },
    { ephemeral: false, shared: false, fail: false },
    { ephemeral: true, shared: true, fail: false },
    { ephemeral: true, shared: false, fail: true },
  ])(
    "joins preparation before use (ephemeral=$ephemeral, shared=$shared, fail=$fail)",
    async ({ ephemeral, shared, fail }) => {
      const overlap = ephemeral && !shared;
      const failure = new Error("private computer preparation failed");
      const gate = createDeferredCore();
      const entered = createDeferredCore();
      const prepare = vi.fn(() => {
        entered.resolve();
        return gate.promise;
      });
      let prepared = false;
      const starting = startComputer(ephemeral, prepare, shared).then((host) => {
        prepared = true;
        return host;
      });
      try {
        await entered.promise;
        await setImmediate();
        expect(prepare).toHaveBeenCalledOnce();
        expect(prepared).toBe(overlap);
        if (!overlap) {
          gate.resolve();
        }
        const host = await starting;
        expect(host.prepared.manifest.commands).toContain("fixture.status");
        expect(host.watchStatus).toHaveBeenCalledOnce();
        expect(host.watchComputer).toHaveBeenCalledTimes(overlap ? 0 : 1);
        if (overlap) {
          expect(await host.runtime.tryPauseForUpdate()).toBe(false);
        }
        let invoked = false;
        const invoking = host
          .invoke(
            ephemeral ? computerOperation("snapshot") : { executionId },
            ephemeral ? NODE_WORKER_DESKTOP_COMPUTER_COMMAND : "screen.snapshot",
          )
          .then((result) => {
            invoked = true;
            return result;
          });
        if (overlap) {
          await setImmediate();
          expect(invoked).toBe(false);
          expect(host.openExecution).not.toHaveBeenCalled();
        }
        if (fail) {
          gate.reject(failure);
        } else {
          gate.resolve();
        }
        expect(await invoking).toMatchObject(
          fail
            ? { ok: false, error: { message: expect.stringContaining(failure.message) } }
            : { ok: true },
        );
        if (fail) {
          expect(await host.runtime.tryPauseForUpdate()).toBe(true);
          host.runtime.resumeAfterUpdate();
          expect(await host.invoke({ operation: "capabilities" })).toMatchObject({
            ok: false,
            error: { message: expect.stringContaining(failure.message) },
          });
        }
        await host.runtime.cancelAll();
        expect(prepare).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        const closing = (await starting).runtime.close();
        if (fail) {
          await expect(closing).rejects.toBe(failure);
        } else {
          await closing;
        }
      }
    },
  );

  it.each([false, true])(
    "drains preparation before close, preserving its failure (fail=%s)",
    async (fail) => {
      const gate = createDeferredCore();
      const failure = new Error("private preparation did not finish");
      const host = await startComputer(true, () => gate.promise);
      let closed = false;
      const closing = host.runtime.close().then(
        () => {
          closed = true;
        },
        (error: unknown) => {
          closed = true;
          return error;
        },
      );
      try {
        await setImmediate();
        expect(closed).toBe(false);
        expect(host.disconnect).not.toHaveBeenCalled();
        expect(host.stopWatching).not.toHaveBeenCalled();
        if (fail) {
          gate.reject(failure);
        } else {
          gate.resolve();
        }
        expect(await closing).toBe(fail ? failure : undefined);
        expect(host.disconnect).toHaveBeenCalledOnce();
        expect(host.stopWatching).toHaveBeenCalledOnce();
        if (fail) {
          await expect(host.runtime.close()).rejects.toBe(failure);
        }
        expect(host.disconnect).toHaveBeenCalledOnce();
        expect(host.stopWatching).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await closing;
      }
    },
  );

  it("retires prepared computer resources when mandatory startup fails", async () => {
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    const failure = new Error("mandatory startup failed");
    const dispose = vi.fn(async () => {});
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "fixture", enabled: true, status: "loaded" }));
    registerComputerUseProvider(
      {
        registerNodeHostCommand: (command) =>
          registry.nodeHostCommands.push({ pluginId: "fixture", source: "test", command }),
      },
      {
        id: "fixture",
        label: "Fixture",
        capabilities: () => descriptor,
        isAvailable: () => true,
        prepare: () => {
          entered.resolve();
          return gate.promise;
        },
        watchAvailability: () => dispose,
        openExecution: async () => {
          throw new Error("No computer execution expected");
        },
      },
    );
    registry.nodeHostCommands.push({
      pluginId: "fixture",
      source: "test",
      command: {
        command: "fixture.required",
        prepare: async () => {
          throw failure;
        },
        handle: async () => "{}",
      },
    });
    setActivePluginRegistry(registry);
    let finished = false;
    const starting = prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      ephemeral: true,
    });
    const observed = starting.then(
      () => {
        finished = true;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    try {
      await entered.promise;
      await setImmediate();
      expect(finished).toBe(false);
      expect(dispose).not.toHaveBeenCalled();
      gate.resolve();
      expect(await observed).toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await observed;
    }
  });

  it("joins watcher and disconnect cleanup until physical computer close settles", async () => {
    const host = await startComputer();
    const physicalClose = createDeferredCore();
    let physicalCloseFinished = false;
    host.close.mockImplementationOnce(async () => {
      await physicalClose.promise;
      physicalCloseFinished = true;
    });
    let closing: Promise<void> | undefined;
    try {
      expect(await host.invoke(computerOperation("snapshot"))).toMatchObject({ ok: true });
      let closed = false;
      closing = host.runtime.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(host.close).toHaveBeenCalledOnce());
      await setImmediate();
      expect(physicalCloseFinished).toBe(false);
      expect(closed).toBe(false);

      physicalClose.resolve();
      await closing;
      expect(physicalCloseFinished).toBe(true);
      expect(host.close).toHaveBeenCalledOnce();
    } finally {
      physicalClose.resolve();
      await closing;
      await host.runtime.close();
    }
  });

  it("joins failed availability cleanup through reentrant runtime close", async () => {
    const host = await startComputer();
    const physicalStop = createDeferredCore();
    const entered = createDeferredCore();
    const failure = new Error("availability retirement failed");
    let reentrant: Promise<void> | undefined;
    host.stopWatching.mockImplementationOnce(async () => {
      reentrant = host.runtime.close();
      entered.resolve();
      await physicalStop.promise;
    });
    let closed = false;
    const closing = host.runtime.close();
    const observed = closing.then(
      () => {
        closed = true;
        return undefined;
      },
      (error: unknown) => {
        closed = true;
        return error;
      },
    );
    try {
      await entered.promise;
      await setImmediate();
      expect(closed).toBe(false);
      expect(host.runtime.close()).toBe(closing);
      expect(reentrant).toBe(closing);
      physicalStop.reject(failure);
      expect(await observed).toBe(failure);
      expect(host.stopWatching).toHaveBeenCalledOnce();
    } finally {
      physicalStop.resolve();
      await observed;
    }
  });

  it("rejects a rotated generation while allowing exact cleanup and a fresh execution", async () => {
    await withComputer(async (host) => {
      expect(await host.invoke(computerOperation("act"))).toMatchObject({
        ok: true,
        payload: { ok: true },
      });
      host.setProviderGeneration("generation-2");
      expect(await host.invoke(computerOperation("snapshot"))).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("COMPUTER_CONTRACT_MISMATCH") },
      });
      expect(host.snapshot).not.toHaveBeenCalled();
      expect(host.act).toHaveBeenCalledOnce();
      await host.invoke({ operation: "close", executionId, reason: "provider-changed" });
      expect(host.close).toHaveBeenCalledExactlyOnceWith("provider-changed");
      expect(await host.invoke({ operation: "capabilities" })).toMatchObject({
        ok: true,
        payload: { provider: { generation: "generation-2" } },
      });
      expect(
        await host.invoke(computerOperation("snapshot", otherExecutionId, "generation-2")),
      ).toMatchObject({
        ok: true,
        payload: { displayFrameId: "frame-1" },
      });
      expect(host.openExecution).toHaveBeenCalledTimes(2);
    });
  });

  it.each([true, false])(
    "enforces the private/public transport boundary for ephemeral=%s",
    async (ephemeral) => {
      await withComputer(async (host) => {
        expect(host.prepared.manifest.computerUse).toEqual(ephemeral ? undefined : descriptor);
        expect(host.prepared.manifest.commands.includes("screen.snapshot")).toBe(!ephemeral);
        expect(host.prepared.manifest.commands.includes("computer.act")).toBe(!ephemeral);
        expect(host.prepared.manifest.commands).not.toContain(NODE_WORKER_DESKTOP_COMPUTER_COMMAND);
        const privateResult = await host.invoke({ operation: "capabilities" });
        expect(privateResult.ok).toBe(ephemeral);
        const publicResult = await host.invoke({ executionId }, "screen.snapshot");
        expect(publicResult.ok).toBe(!ephemeral);
        expect(host.snapshot).toHaveBeenCalledTimes(ephemeral ? 0 : 1);
      }, ephemeral);
    },
  );

  it("rejects the internal close action before the provider", async () => {
    await withComputer(async (host) => {
      expect(
        await host.invoke({
          operation: "act",
          providerGeneration: descriptor.provider.generation,
          params: { executionId, action: "__close_execution" },
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(host.openExecution).not.toHaveBeenCalled();
    });
  });
});
