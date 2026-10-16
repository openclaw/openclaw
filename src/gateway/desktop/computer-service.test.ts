import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import { registerComputerUseProvider } from "../../plugins/computer-use-registration.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startComputerHostProcess, type ComputerHostProcess } from "./computer-process.js";
import { ComputerHostFinalizationError } from "./computer-protocol.js";
import { createGatewayComputerService, type GatewayComputerService } from "./computer-service.js";
import { computerCapabilities, observeSettlement, whileHeld } from "./computer.test-support.js";
import type { HostDesktopService } from "./host-source.js";
import type { DesktopComputerLease } from "./managed-linux.js";

vi.mock("./computer-process.js", () => ({ startComputerHostProcess: vi.fn() }));

const logicalId = "123e4567-e89b-42d3-a456-426614174000";
const screenshot = { format: "png", base64: "cGl4ZWxz" };
const startHost = vi.mocked(startComputerHostProcess);
const cleanups: Array<() => Promise<void>> = [];

function delayReadiness() {
  const started = createDeferredCore();
  const ready = createDeferredCore();
  const startProcess = startHost.getMockImplementation()!;
  const close = vi.fn<ComputerHostProcess["close"]>();
  startHost.mockImplementationOnce((options) => {
    const child = startProcess(options);
    close.mockImplementation((execution) => child.close(execution));
    started.resolve();
    return { ...child, close, ready: ready.promise.then(() => child.ready) };
  });
  return { started: started.promise, ready, close };
}

let f: ReturnType<typeof createFixture>;
beforeEach(() => {
  startHost.mockReset();
  f = createFixture();
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function createFixture() {
  const config: OpenClawConfig = {
    desktop: { host: { enabled: true, managed: true } },
    plugins: { entries: { fixture: { enabled: true } } },
  };
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: "fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    }),
  );
  const snapshot = vi.fn(async (_paramsJSON?: string | null) => JSON.stringify(screenshot));
  const act = vi.fn(async (_paramsJSON?: string | null) => JSON.stringify({ ok: true }));
  const physicalClose = vi.fn(async (_reason: string) => {});
  const openExecution = vi.fn(async (_context: { executionId: string }) => ({
    snapshot,
    act,
    close: physicalClose,
  }));
  let generation = 0;
  const capabilities = () =>
    computerCapabilities({
      id: "fixture",
      label: "Fixture computer",
      generation: `generation-${generation}`,
    });
  registerComputerUseProvider(
    {
      registerNodeHostCommand: (command) =>
        registry.nodeHostCommands.push({
          pluginId: "fixture",
          pluginName: "Fixture",
          command,
          source: "fixture",
        }),
    },
    {
      id: "fixture",
      label: "Fixture computer",
      capabilities,
      isAvailable: () => true,
      openExecution,
    },
  );
  const leases: Array<
    Omit<DesktopComputerLease, "release"> & {
      valid: boolean;
      release: ReturnType<typeof vi.fn<() => void>>;
    }
  > = [];
  const stops: Array<() => Promise<void>> = [];
  const desktop: HostDesktopService = {
    reconcileRuntimePolicy: async () => {},
    observe: async () => {
      throw new Error("Computer control must not acquire an observer token");
    },
    status: async () => {
      throw new Error("Computer control must acquire its own lease");
    },
    acquireComputer: async (request) => {
      const lease = {
        env: {
          PATH: process.env.PATH,
          DISPLAY: ":99",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture/bus",
        },
        valid: true,
        isCurrent: () => lease.valid,
        release: vi.fn(() => {
          lease.valid = false;
        }),
      };
      leases.push(lease);
      stops.push(() => request.onStop());
      return lease;
    },
  };
  const children: ComputerHostProcess[] = [];
  startHost.mockImplementation((options) => {
    options.assertCurrent();
    generation += 1;
    let active = true;
    const child: ComputerHostProcess = {
      ready: Promise.resolve(capabilities()),
      isCurrent: () => active,
      invoke: async (request) => {
        request.assertCurrent();
        const command = registry.nodeHostCommands.find(
          (entry) => entry.command.command === request.command,
        )!.command;
        return JSON.parse(await command.handle(JSON.stringify(request.params)));
      },
      close: vi.fn(async (execution?: { executionId: string; reason: string }) => {
        active = false;
        if (execution) {
          await registry.nodeHostCommands
            .find((entry) => entry.command.command === "computer.act")!
            .command.handle(JSON.stringify({ ...execution, action: "__close_execution" }));
        }
        await registry.nodeHostCommands
          .find((entry) => entry.command.onDisconnect)
          ?.command.onDisconnect?.();
      }),
    };
    children.push(child);
    return child;
  });
  const service = createGatewayComputerService({
    getConfig: () => config,
    getPluginRegistry: () => registry,
    hostDesktopService: desktop,
  });
  cleanups.push(async () => {
    physicalClose.mockResolvedValue();
    await service.close();
  });
  const request = (overrides: Partial<Parameters<GatewayComputerService["invoke"]>[0]> = {}) => ({
    command: "screen.snapshot" as const,
    params: { executionId: logicalId },
    generation: `generation-${generation}`,
    owner: "session-a",
    assertCurrent: () => {},
    idempotencyKey: "observe-1",
    ...overrides,
  });
  const click = (idempotencyKey: string) =>
    request({
      command: "computer.act",
      params: { executionId: logicalId, action: "left_click", x: 1, y: 2 },
      idempotencyKey,
    });
  const mocks = { start: startHost, snapshot, act, open: openExecution, close: physicalClose };
  const calls = (expected: Partial<Record<keyof typeof mocks | "release" | "leases", number>>) =>
    expect({
      ...Object.fromEntries(
        Object.entries(mocks).map(([key, mock]) => [key, mock.mock.calls.length]),
      ),
      release: leases[0]?.release.mock.calls.length,
      leases: leases.length,
    }).toMatchObject(expected);
  return {
    calls,
    service,
    config,
    registry,
    desktop,
    snapshot,
    act,
    openExecution,
    physicalClose,
    children,
    leases,
    stops,
    request,
    click,
    declared: () => service.status({ probe: false }),
    holdCleanup: () => {
      const gate = createDeferredCore();
      physicalClose.mockImplementationOnce(() => gate.promise);
      return gate;
    },
    invoke: (overrides?: Parameters<typeof request>[0]) => service.invoke(request(overrides)),
  };
}

async function expectCleanupHeld<T>(
  gate: ReturnType<typeof createDeferredCore<void>>,
  pending: Promise<T>,
  check: () => void | Promise<void>,
  close: (...args: never[]) => Promise<void> = f.physicalClose,
  count = 1,
) {
  const observed = observeSettlement(pending);
  await whileHeld(gate, async () => {
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(count));
    await check();
    expect(close).toHaveBeenCalledTimes(count);
    expect(observed.settled).not.toHaveBeenCalled();
  });
  return await pending;
}

describe("Gateway computer service", () => {
  it("reads declared and recorded capabilities without starting or waiting for a computer", async () => {
    const cold = await f.declared();
    expect(cold).toMatchObject({
      configured: true,
      available: false,
      computerUse: { provider: { generation: "generation-0" } },
    });
    f.calls({ start: 0, leases: 0 });

    const delayed = delayReadiness();
    const probing = f.service.status({ probe: true });
    await whileHeld(delayed.ready, async () => {
      await delayed.started;
      expect(await f.declared()).toEqual(cold);
    });
    const live = await probing;
    expect(live).toMatchObject({
      available: true,
      computerUse: { provider: { generation: "generation-1" } },
    });
    expect(await f.declared()).toEqual(live);
    f.leases[0]!.valid = false;
    expect(await f.declared()).toMatchObject({
      available: false,
      computerUse: cold.computerUse,
    });
    f.calls({ start: 1, release: 0 });
  });

  it("does not renew or restart an idle computer when reading its status", async () => {
    vi.useFakeTimers();
    try {
      const live = await f.service.status();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await f.declared()).toEqual(live);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await f.declared()).toMatchObject({
        configured: true,
        available: false,
        computerUse: { actions: ["screenshot", "left_click"] },
      });
      f.calls({ start: 1, release: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps native readiness authoritative when an unprepared declaration fails", async () => {
    const entry = f.registry.nodeHostCommands.find((candidate) => candidate.command.computerUse)!;
    entry.command.computerUse = () => {
      throw new Error("Declaration needs a native desktop");
    };
    expect(await f.declared()).toMatchObject({
      configured: true,
      available: false,
      error: "Declaration needs a native desktop",
    });
    expect(startComputerHostProcess).not.toHaveBeenCalled();
    expect(await f.service.status({ probe: true })).toMatchObject({ available: true });
    expect(await f.declared()).toMatchObject({ available: true });
  });

  it("invalidates declared capabilities on provider replacement and disablement", async () => {
    const entry = f.registry.nodeHostCommands.find((candidate) => candidate.command.computerUse)!;
    const descriptor = (await f.declared()).computerUse!;
    const computerUse = vi.fn(() => ({ ...descriptor, actions: ["screenshot", "list_windows"] }));
    entry.command = { ...entry.command, computerUse };
    expect((await f.declared()).computerUse?.actions).toContain("list_windows");
    await f.declared();
    expect(computerUse).toHaveBeenCalledOnce();
    f.config.plugins!.entries!.fixture!.enabled = false;
    expect(await f.declared()).toEqual({ configured: false, available: false });
    f.config.plugins!.entries!.fixture!.enabled = true;
    expect((await f.declared()).computerUse?.actions).toContain("list_windows");
    expect(computerUse).toHaveBeenCalledTimes(2);
    expect(startComputerHostProcess).not.toHaveBeenCalled();
  });

  it.each(["native target", "managed target", "desktop", "helper"] as const)(
    "fences stale %s input and joins cleanup before concurrent discovery",
    async (source) => {
      const initiallyManaged = source !== "native target";
      f.config.desktop!.host!.enabled = initiallyManaged;
      const original = await f.service.status();
      expect(original.available).toBe(true);
      await f.invoke();
      const originalGeneration = original.computerUse!.provider.generation;

      if (source === "desktop") {
        f.leases[0]!.valid = false;
      } else if (source === "helper") {
        vi.spyOn(f.children[0]!, "isCurrent").mockReturnValue(false);
      } else {
        f.config.desktop!.host!.enabled = !initiallyManaged;
      }
      await expect(
        f.service.invoke({ ...f.click("stale-target-click"), generation: originalGeneration }),
      ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      f.calls({ act: 0, start: 1 });

      const cleanup = f.holdCleanup();
      const discovery = Promise.all([f.service.status(), f.service.status(), f.service.status()]);
      const results = await expectCleanupHeld(cleanup, discovery, () => {
        f.calls({ start: 1, leases: initiallyManaged ? 1 : 0 });
        if (initiallyManaged) {
          expect(f.leases[0]!.release).not.toHaveBeenCalled();
        }
      });

      expect(results.every((result) => result.available)).toBe(true);
      const generations = results.map((result) => result.computerUse?.provider.generation);
      expect(new Set(generations).size).toBe(1);
      expect(generations[0]).not.toBe(originalGeneration);
      expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
      const nextEnvironment = startHost.mock.calls[1]![0].env;
      expect(nextEnvironment).toBe(
        source === "managed target" ? process.env : f.leases.at(-1)!.env,
      );
      if (initiallyManaged) {
        expect(f.leases[0]!.release).toHaveBeenCalledOnce();
      }
      await expect(f.invoke({ generation: originalGeneration })).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
      f.calls({ act: 0, snapshot: 1, open: 1 });
    },
  );

  it("does not publish a native computer whose desktop target changes during readiness", async () => {
    f.config.desktop!.host!.enabled = false;
    const delayed = delayReadiness();
    const discovering = f.service.status();
    await whileHeld(delayed.ready, async () => {
      await delayed.started;
      f.config.desktop!.host!.enabled = true;
    });
    expect(await discovering).toMatchObject({ available: false });
    expect(delayed.close).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startHost.mock.calls[1]![0].env).toBe(f.leases[0]!.env);
    f.calls({ start: 2, open: 0 });
  });

  it.each(["policy change", "operator disconnect"] as const)(
    "joins native cleanup on %s before another discovery",
    async (cause) => {
      const disconnect = cause === "operator disconnect";
      f.config.desktop!.host!.enabled = disconnect;
      const owner = new AbortController();
      await f.service.status();
      await f.invoke(disconnect ? { ownerSignal: owner.signal } : {});
      if (disconnect) {
        await f.service.invoke(f.click("click-1"));
      }
      const cleanup = f.holdCleanup();
      if (disconnect) {
        owner.abort();
      } else {
        f.config.desktop!.host!.enabled = true;
      }
      const pending = disconnect ? f.service.status() : f.service.reconcileRuntimePolicy();
      const result = await expectCleanupHeld<Awaited<typeof pending>>(
        cleanup,
        pending,
        async () => {
          if (!disconnect) {
            await expect(f.invoke({ idempotencyKey: "after-reload" })).rejects.toThrow(
              "COMPUTER_STALE_OBSERVATION",
            );
          }
          expect(startComputerHostProcess).toHaveBeenCalledOnce();
          if (disconnect) {
            expect(f.leases[0]!.release).not.toHaveBeenCalled();
          }
        },
      );
      if (disconnect) {
        expect(result).toMatchObject({ available: true });
        f.calls({ release: 1, act: 1 });
      } else {
        f.calls({ start: 1, leases: 0 });
        expect(await f.service.status()).toMatchObject({ available: true });
        expect(startHost.mock.calls[1]![0].env).toBe(f.leases[0]!.env);
      }
      expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["commit", "rollback"])("joins provider revocation before reload %s", async (outcome) => {
    const original = await f.service.status();
    await f.invoke();
    const unrelated = f.service.preparePluginReload({ changedPluginIds: new Set(["other"]) });
    await unrelated.drain();
    unrelated.resume();
    expect(f.physicalClose).not.toHaveBeenCalled();
    expect(await f.service.status()).toEqual(original);

    const cleanup = f.holdCleanup();
    const reload = f.service.preparePluginReload({ changedPluginIds: new Set(["fixture"]) });
    expect(await f.service.status()).toMatchObject({
      available: false,
      error: expect.stringContaining("reloading"),
    });
    await expect(f.invoke({ idempotencyKey: "during-reload" })).rejects.toThrow("closed");
    await expectCleanupHeld(cleanup, reload.drain(), () => {
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
    });
    f.calls({ release: 1 });
    if (outcome === "commit") {
      f.config.plugins!.entries!.fixture!.enabled = false;
    }
    reload.resume();
    const next = await f.service.status();
    if (outcome === "commit") {
      expect(next).toEqual({ configured: false, available: false });
      expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
    } else {
      expect(next.available).toBe(true);
      expect(next.computerUse?.provider.generation).not.toBe(
        original.computerUse?.provider.generation,
      );
    }
  });

  it("releases a late desktop lease without launching the retired preparation after reload resumes", async () => {
    const acquired = createDeferredCore<DesktopComputerLease>();
    vi.spyOn(f.desktop, "acquireComputer").mockReturnValueOnce(acquired.promise);
    const discovering = f.service.status();
    const reload = f.service.preparePluginReload({ changedPluginIds: new Set(["fixture"]) });
    await reload.drain();
    reload.resume();
    const release = vi.fn();
    acquired.resolve({ env: {}, isCurrent: () => true, release });
    expect(await discovering).toMatchObject({ available: false });
    expect(startComputerHostProcess).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
  });

  it("discovers its managed computer without pairing and binds native executions to the requesting owner", async () => {
    expect(await f.service.status()).toMatchObject({ configured: true, available: true });
    expect(startComputerHostProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: f.leases[0]!.env,
        pluginIds: ["fixture"],
      }),
    );
    await expect(f.invoke()).resolves.toEqual(screenshot);
    const physicalId = f.openExecution.mock.calls[0]![0].executionId;
    expect(physicalId).not.toBe(logicalId);
    await f.service.invoke(f.click("click-1"));
    expect(JSON.parse(f.act.mock.calls[0]![0] ?? "{}")).toMatchObject({
      executionId: physicalId,
      action: "left_click",
    });
    for (const overrides of [
      { owner: "session-b" },
      { params: { executionId: "223e4567-e89b-42d3-a456-426614174000" } },
      {
        owner: "session-b",
        command: "computer.act" as const,
        params: { executionId: logicalId, action: "__close_execution" },
      },
    ]) {
      await expect(f.invoke(overrides)).rejects.toThrow("COMPUTER_HOST_BUSY");
    }
    f.calls({ open: 1, close: 0 });
    await f.service.close();
    f.calls({ close: 1, release: 1 });
  });

  it("joins duplicate pending input and prevents replay after settlement", async () => {
    const result = createDeferredCore<string>();
    f.snapshot.mockReturnValueOnce(result.promise);
    await f.service.status();
    const first = f.invoke();
    const duplicate = f.invoke();
    const joined = Promise.all([first, duplicate]);
    try {
      await expect(f.invoke({ params: { executionId: logicalId, maxWidth: 300 } })).rejects.toThrow(
        "different input",
      );
    } finally {
      result.resolve(JSON.stringify(screenshot));
    }
    await joined;
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    await expect(f.invoke()).rejects.toThrow("already settled");
  });

  it("joins native preparation on shutdown and releases the acquired desktop after the child closes", async () => {
    const nativeReady = createDeferredCore<ComputerUseCapabilityDescriptor>();
    const launchStarted = createDeferredCore();
    const closed = createDeferredCore();
    const childClose = vi.fn(() => {
      nativeReady.reject(new Error("Native preparation was closed"));
      return closed.promise;
    });
    startHost.mockImplementationOnce(() => {
      launchStarted.resolve();
      return {
        ready: nativeReady.promise,
        isCurrent: () => true,
        invoke: async () => {},
        close: childClose,
      };
    });
    const discovering = f.service.status();
    await launchStarted.promise;
    await expectCleanupHeld(
      closed,
      f.service.close(),
      () => {
        expect(f.leases[0]!.release).not.toHaveBeenCalled();
      },
      childClose,
    );
    expect(await discovering).toMatchObject({ available: false });
    expect(f.leases[0]!.release).toHaveBeenCalled();
    expect(f.openExecution).not.toHaveBeenCalled();
  });

  it.each(["preparation", "execution"] as const)(
    "retains custody after failed %s cleanup and retries before discovery",
    async (stage) => {
      const cleanup = createDeferredCore();
      const message =
        stage === "preparation" ? "Native process could not be joined" : "native cleanup failed";
      const childClose = vi.fn(() => cleanup.promise).mockRejectedValueOnce(new Error(message));
      if (stage === "preparation") {
        startHost.mockImplementationOnce(() => ({
          ready: Promise.reject(new Error("Native preparation failed")),
          isCurrent: () => false,
          invoke: async () => {},
          close: childClose,
        }));
      } else {
        await f.service.status();
        await f.invoke();
        f.physicalClose.mockRejectedValue(new Error(message));
        await expect(f.stops[0]!()).rejects.toThrow(message);
        expect(f.leases[0]!.release).not.toHaveBeenCalled();
      }
      expect(await f.service.status()).toMatchObject({ available: false, error: message });
      f.calls({ release: 0, start: 1 });
      if (stage === "execution") {
        await expect(f.invoke({ idempotencyKey: "after-failure" })).rejects.toThrow(
          "COMPUTER_STALE_OBSERVATION",
        );
        expect(f.snapshot).toHaveBeenCalledOnce();
        f.physicalClose.mockImplementation(() => cleanup.promise);
      }
      const retry = await expectCleanupHeld(
        cleanup,
        f.service.status(),
        () => f.calls({ release: 0, start: 1 }),
        stage === "preparation" ? childClose : f.physicalClose,
        stage === "preparation" ? 2 : 3,
      );
      expect(retry).toMatchObject({ available: true });
      f.calls({ release: 1, start: 2 });
    },
  );

  it("reports a terminated helper's finalization failure while releasing its proven physical custody", async () => {
    await f.service.status();
    await f.invoke();
    const child = f.children[0]!;
    await child.close();
    const failure = new ComputerHostFinalizationError(
      new Error("Native helper exited unexpectedly"),
    );
    vi.spyOn(child, "close").mockRejectedValue(failure);
    await expect(
      f.invoke({
        command: "computer.act",
        params: { executionId: logicalId, action: "__close_execution", reason: "completion" },
      }),
    ).rejects.toBe(failure);
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(await f.service.status()).toMatchObject({ available: true });
    f.calls({ start: 2, snapshot: 1, open: 1 });
  });

  it("joins repeated execution close through failure and retries cleanup before releasing ownership", async () => {
    await f.service.status();
    await f.invoke();
    const cleanup = f.holdCleanup();
    const failure = new Error("native cleanup failed");
    const closeRequest = f.request({
      command: "computer.act",
      params: { executionId: logicalId, action: "__close_execution" },
    });
    const first = f.service.invoke(closeRequest);
    const firstObserved = Promise.allSettled([first]);
    await vi.waitFor(() => expect(f.physicalClose).toHaveBeenCalledTimes(1));
    const duplicate = f.service.invoke(closeRequest);
    const duplicateSettled = vi.fn();
    const duplicateObserved = duplicate.then(duplicateSettled, duplicateSettled);
    const results = Promise.allSettled([first, duplicate]);
    try {
      await expect(f.service.invoke({ ...closeRequest, owner: "session-b" })).rejects.toThrow(
        "COMPUTER_HOST_BUSY",
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(duplicateSettled).not.toHaveBeenCalled();
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
    } finally {
      cleanup.reject(failure);
    }
    expect(await results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await firstObserved;
    await duplicateObserved;
    await expect(f.service.invoke(closeRequest)).resolves.toEqual({ ok: true });
    expect(f.physicalClose).toHaveBeenLastCalledWith("completion");
    f.calls({ close: 2, release: 1 });
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
  });

  it.each(["plugins-disabled", "provider-disabled", "provider-default", "provider-unloaded"])(
    "does not start a computer when %s",
    async (mode) => {
      if (mode === "plugins-disabled") {
        f.config.plugins!.enabled = false;
      }
      if (mode === "provider-disabled") {
        f.config.plugins!.entries!.fixture!.enabled = false;
      }
      if (mode === "provider-default") {
        delete f.config.plugins!.entries!.fixture;
      }
      if (mode === "provider-unloaded") {
        f.registry.plugins[0]!.status = "error";
      }
      expect(await f.service.status()).toEqual({ configured: false, available: false });
      f.calls({ start: 0, leases: 0 });
    },
  );
});
