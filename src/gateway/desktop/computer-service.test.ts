import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  registerComputerUseProvider,
  type ComputerUseCapabilityDescriptor,
} from "../../plugins/computer-use-contract.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { startComputerHostProcess, type ComputerHostProcess } from "./computer-process.js";
import { ComputerHostFinalizationError } from "./computer-protocol.js";
import { createGatewayComputerService, type GatewayComputerService } from "./computer-service.js";
import type { HostDesktopService } from "./host-source.js";
import type { DesktopComputerLease } from "./managed-linux.js";

vi.mock("./computer-process.js", () => ({ startComputerHostProcess: vi.fn() }));

const logicalId = "123e4567-e89b-42d3-a456-426614174000";
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.mocked(startComputerHostProcess).mockReset();
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
  const snapshot = vi.fn(async (_paramsJSON?: string | null) =>
    JSON.stringify({ format: "png", base64: "cGl4ZWxz" }),
  );
  const act = vi.fn(async (_paramsJSON?: string | null) => JSON.stringify({ ok: true }));
  const physicalClose = vi.fn(async (_reason: string) => {});
  const openExecution = vi.fn(async (_context: { executionId: string }) => ({
    snapshot,
    act,
    close: physicalClose,
  }));
  let generation = 0;
  const capabilities = (): ComputerUseCapabilityDescriptor => ({
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture computer", generation: `generation-${generation}` },
    actions: ["screenshot", "left_click"],
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
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
  vi.mocked(startComputerHostProcess).mockImplementation((options) => {
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
  return {
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
  };
}

describe("Gateway computer service", () => {
  it.each(["native", "managed"] as const)(
    "fences cached %s input and joins cleanup before discovering the changed desktop target",
    async (initialTarget) => {
      const f = createFixture();
      const initiallyManaged = initialTarget === "managed";
      f.config.desktop!.host!.enabled = initiallyManaged;
      const original = await f.service.status();
      expect(original.available).toBe(true);
      await f.service.invoke(f.request());
      const originalGeneration = original.computerUse!.provider.generation;

      f.config.desktop!.host!.enabled = !initiallyManaged;
      await expect(
        f.service.invoke(
          f.request({
            command: "computer.act",
            params: { executionId: logicalId, action: "left_click", x: 1, y: 2 },
            generation: originalGeneration,
            idempotencyKey: "stale-target-click",
          }),
        ),
      ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      expect(f.act).not.toHaveBeenCalled();

      const cleanup = createDeferredCore();
      f.physicalClose.mockImplementationOnce(() => cleanup.promise);
      const discovered = vi.fn();
      const discovery = Promise.all([f.service.status(), f.service.status()]).then((results) => {
        discovered();
        return results;
      });
      try {
        await vi.waitFor(() => expect(f.physicalClose).toHaveBeenCalledOnce());
        expect(discovered).not.toHaveBeenCalled();
        expect(startComputerHostProcess).toHaveBeenCalledOnce();
        expect(f.leases).toHaveLength(initiallyManaged ? 1 : 0);
        if (initiallyManaged) {
          expect(f.leases[0]!.release).not.toHaveBeenCalled();
        }
      } finally {
        cleanup.resolve();
      }

      const results = await discovery;
      expect(results.every((result) => result.available)).toBe(true);
      const generations = results.map((result) => result.computerUse?.provider.generation);
      expect(new Set(generations).size).toBe(1);
      expect(generations[0]).not.toBe(originalGeneration);
      expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
      const nextEnvironment = vi.mocked(startComputerHostProcess).mock.calls[1]![0].env;
      expect(nextEnvironment === (initiallyManaged ? process.env : f.leases[0]!.env)).toBe(true);
      if (initiallyManaged) {
        expect(f.leases[0]!.release).toHaveBeenCalledOnce();
      }
      await expect(f.service.invoke(f.request({ generation: originalGeneration }))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
      expect(f.act).not.toHaveBeenCalled();
      expect(f.snapshot).toHaveBeenCalledOnce();
    },
  );

  it("does not publish a native computer whose desktop target changes during readiness", async () => {
    const f = createFixture();
    f.config.desktop!.host!.enabled = false;
    const started = createDeferredCore();
    const ready = createDeferredCore();
    const close = vi.fn<ComputerHostProcess["close"]>();
    const startProcess = vi.mocked(startComputerHostProcess).getMockImplementation()!;
    vi.mocked(startComputerHostProcess).mockImplementationOnce((options) => {
      const child = startProcess(options);
      close.mockImplementation((execution) => child.close(execution));
      started.resolve();
      return { ...child, close, ready: ready.promise.then(() => child.ready) };
    });
    const discovering = f.service.status();
    try {
      await started.promise;
      f.config.desktop!.host!.enabled = true;
    } finally {
      ready.resolve();
    }
    expect(await discovering).toMatchObject({ available: false });
    expect(close).toHaveBeenCalledOnce();
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startComputerHostProcess).mock.calls[1]![0].env === f.leases[0]!.env).toBe(
      true,
    );
    expect(f.openExecution).not.toHaveBeenCalled();
  });

  it("retires a changed desktop target during policy reconciliation without eagerly replacing it", async () => {
    const f = createFixture();
    f.config.desktop!.host!.enabled = false;
    await f.service.status();
    await f.service.invoke(f.request());
    const cleanup = createDeferredCore();
    f.physicalClose.mockImplementationOnce(() => cleanup.promise);
    f.config.desktop!.host!.enabled = true;
    const reconciled = vi.fn();
    const reconciling = f.service.reconcileRuntimePolicy().then(reconciled);
    try {
      await expect(f.service.invoke(f.request({ idempotencyKey: "after-reload" }))).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
      await vi.waitFor(() => expect(f.physicalClose).toHaveBeenCalledOnce());
      expect(reconciled).not.toHaveBeenCalled();
      expect(startComputerHostProcess).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
    }
    await reconciling;
    expect(startComputerHostProcess).toHaveBeenCalledOnce();
    expect(f.leases).toHaveLength(0);
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startComputerHostProcess).mock.calls[1]![0].env === f.leases[0]!.env).toBe(
      true,
    );
  });

  it.each(["commit", "rollback"])("joins provider revocation before reload %s", async (outcome) => {
    const f = createFixture();
    const original = await f.service.status();
    await f.service.invoke(f.request());
    const unrelated = f.service.preparePluginReload({ changedPluginIds: new Set(["other"]) });
    await unrelated.drain();
    unrelated.resume();
    expect(f.physicalClose).not.toHaveBeenCalled();
    expect(await f.service.status()).toEqual(original);

    const cleanup = createDeferredCore();
    f.physicalClose.mockImplementationOnce(() => cleanup.promise);
    const reload = f.service.preparePluginReload({ changedPluginIds: new Set(["fixture"]) });
    expect(await f.service.status()).toMatchObject({
      available: false,
      error: expect.stringContaining("reloading"),
    });
    await expect(f.service.invoke(f.request({ idempotencyKey: "during-reload" }))).rejects.toThrow(
      "closed",
    );
    const drained = vi.fn();
    const draining = reload.drain().then(drained);
    try {
      await vi.waitFor(() => expect(f.physicalClose).toHaveBeenCalledTimes(1));
      expect(drained).not.toHaveBeenCalled();
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
    }
    await draining;
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
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
    const f = createFixture();
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
    const f = createFixture();
    expect(await f.service.status()).toMatchObject({ configured: true, available: true });
    expect(startComputerHostProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: f.leases[0]!.env,
        pluginIds: ["fixture"],
      }),
    );
    await expect(f.service.invoke(f.request())).resolves.toEqual({
      format: "png",
      base64: "cGl4ZWxz",
    });
    const physicalId = f.openExecution.mock.calls[0]![0].executionId;
    expect(physicalId).not.toBe(logicalId);
    await f.service.invoke(
      f.request({
        command: "computer.act",
        params: { executionId: logicalId, action: "left_click", x: 1, y: 2 },
        idempotencyKey: "click-1",
      }),
    );
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
      await expect(f.service.invoke(f.request(overrides))).rejects.toThrow("COMPUTER_HOST_BUSY");
    }
    expect(f.openExecution).toHaveBeenCalledTimes(1);
    expect(f.physicalClose).not.toHaveBeenCalled();
    await f.service.close();
    expect(f.physicalClose).toHaveBeenCalledTimes(1);
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
  });

  it("joins duplicate pending input and prevents replay after settlement", async () => {
    const f = createFixture();
    const result = createDeferredCore<string>();
    f.snapshot.mockReturnValueOnce(result.promise);
    await f.service.status();
    const first = f.service.invoke(f.request());
    const duplicate = f.service.invoke(f.request());
    const joined = Promise.all([first, duplicate]);
    try {
      await expect(
        f.service.invoke(f.request({ params: { executionId: logicalId, maxWidth: 300 } })),
      ).rejects.toThrow("different input");
    } finally {
      result.resolve(JSON.stringify({ format: "png", base64: "cGl4ZWxz" }));
    }
    await joined;
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    await expect(f.service.invoke(f.request())).rejects.toThrow("already settled");
  });

  it("joins native preparation on shutdown and releases the acquired desktop after the child closes", async () => {
    const f = createFixture();
    const nativeReady = createDeferredCore<ComputerUseCapabilityDescriptor>();
    const launchStarted = createDeferredCore();
    const closed = createDeferredCore();
    const childClose = vi.fn(() => {
      nativeReady.reject(new Error("Native preparation was closed"));
      return closed.promise;
    });
    vi.mocked(startComputerHostProcess).mockImplementationOnce(() => {
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
    const stopped = vi.fn();
    const stopping = f.service.close().then(stopped);
    try {
      await vi.waitFor(() => expect(childClose).toHaveBeenCalled());
      expect(stopped).not.toHaveBeenCalled();
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
    } finally {
      closed.resolve();
    }
    await stopping;
    expect(await discovering).toMatchObject({ available: false });
    expect(f.leases[0]!.release).toHaveBeenCalled();
    expect(f.openExecution).not.toHaveBeenCalled();
  });

  it("retains the original cleanup handle and desktop when readiness and physical cleanup fail", async () => {
    const f = createFixture();
    const cleanup = createDeferredCore();
    const childClose = vi
      .fn(() => cleanup.promise)
      .mockRejectedValueOnce(new Error("Native process could not be joined"));
    vi.mocked(startComputerHostProcess).mockImplementationOnce(() => ({
      ready: Promise.reject(new Error("Native preparation failed")),
      isCurrent: () => false,
      invoke: async () => {},
      close: childClose,
    }));
    expect(await f.service.status()).toMatchObject({
      available: false,
      error: "Native process could not be joined",
    });
    expect(f.leases[0]!.release).not.toHaveBeenCalled();
    const discovered = vi.fn();
    const retry = f.service.status().then((result) => {
      discovered(result);
      return result;
    });
    try {
      await vi.waitFor(() => expect(childClose).toHaveBeenCalledTimes(2));
      expect(discovered).not.toHaveBeenCalled();
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
      expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
    }
    expect(await retry).toMatchObject({ available: true });
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
  });

  it("reports a terminated helper's finalization failure while releasing its proven physical custody", async () => {
    const f = createFixture();
    await f.service.status();
    await f.service.invoke(f.request());
    const child = f.children[0]!;
    await child.close();
    const failure = new ComputerHostFinalizationError(
      new Error("Native helper exited unexpectedly"),
    );
    vi.spyOn(child, "close").mockRejectedValue(failure);
    await expect(
      f.service.invoke(
        f.request({
          command: "computer.act",
          params: { executionId: logicalId, action: "__close_execution", reason: "completion" },
        }),
      ),
    ).rejects.toBe(failure);
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    expect(f.openExecution).toHaveBeenCalledTimes(1);
  });

  it("joins repeated execution close through failure and retries cleanup before releasing ownership", async () => {
    const f = createFixture();
    await f.service.status();
    await f.service.invoke(f.request());
    const cleanup = createDeferredCore();
    const failure = new Error("native cleanup failed");
    f.physicalClose.mockImplementationOnce(() => cleanup.promise);
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
    expect(f.physicalClose).toHaveBeenCalledTimes(2);
    expect(f.physicalClose).toHaveBeenLastCalledWith("completion");
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(await f.service.status()).toMatchObject({ available: true });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
  });

  it("retires on operator disconnect after input settles and waits for cleanup before another discovery", async () => {
    const f = createFixture();
    const owner = new AbortController();
    await f.service.status();
    await f.service.invoke(f.request({ ownerSignal: owner.signal }));
    await f.service.invoke(
      f.request({
        command: "computer.act",
        params: { executionId: logicalId, action: "left_click", x: 1, y: 2 },
        idempotencyKey: "click-1",
      }),
    );
    const cleanup = createDeferredCore();
    f.physicalClose.mockImplementationOnce(() => cleanup.promise);
    owner.abort();
    const discovered = vi.fn();
    const discovery = f.service.status().then((result) => {
      discovered(result);
      return result;
    });
    try {
      await vi.waitFor(() => expect(f.physicalClose).toHaveBeenCalledTimes(1));
      expect(discovered).not.toHaveBeenCalled();
      expect(f.leases[0]!.release).not.toHaveBeenCalled();
      expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
    } finally {
      cleanup.resolve();
    }
    expect(await discovery).toMatchObject({ available: true });
    expect(f.leases[0]!.release).toHaveBeenCalledTimes(1);
    expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
    expect(f.act).toHaveBeenCalledTimes(1);
  });

  it.each(["desktop", "helper"])(
    "reports a stale %s before replacing it once for concurrent discovery without replaying input",
    async (source) => {
      const f = createFixture();
      const first = await f.service.status();
      await f.service.invoke(f.request());
      if (source === "desktop") {
        f.leases[0]!.valid = false;
      } else {
        vi.spyOn(f.children[0]!, "isCurrent").mockReturnValue(false);
      }
      await expect(
        f.service.invoke(
          f.request({
            command: "computer.act",
            params: { executionId: logicalId, action: "left_click", x: 1, y: 2 },
            idempotencyKey: "stale-click",
          }),
        ),
      ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      expect(f.act).not.toHaveBeenCalled();
      expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
      const results = await Promise.all([
        f.service.status(),
        f.service.status(),
        f.service.status(),
      ]);
      expect(results.every((result) => result.available)).toBe(true);
      expect(new Set(results.map((result) => result.computerUse?.provider.generation)).size).toBe(
        1,
      );
      expect(startComputerHostProcess).toHaveBeenCalledTimes(2);
      await expect(
        f.service.invoke(f.request({ generation: first.computerUse!.provider.generation })),
      ).rejects.toThrow("COMPUTER_STALE_OBSERVATION");
      expect(f.snapshot).toHaveBeenCalledTimes(1);
      expect(f.openExecution).toHaveBeenCalledTimes(1);
    },
  );

  it("retains a desktop whose native cleanup failed and reports failure instead of starting another computer", async () => {
    const f = createFixture();
    await f.service.status();
    await f.service.invoke(f.request());
    f.physicalClose.mockRejectedValue(new Error("native cleanup failed"));
    await expect(f.stops[0]!()).rejects.toThrow("native cleanup failed");
    expect(f.leases[0]!.release).not.toHaveBeenCalled();
    expect(await f.service.status()).toMatchObject({
      available: false,
      error: "native cleanup failed",
    });
    expect(startComputerHostProcess).toHaveBeenCalledTimes(1);
    await expect(f.service.invoke(f.request({ idempotencyKey: "after-failure" }))).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );
    expect(f.snapshot).toHaveBeenCalledTimes(1);
  });

  it.each(["plugins-disabled", "provider-disabled", "provider-default", "provider-unloaded"])(
    "does not start a computer when %s",
    async (mode) => {
      const f = createFixture();
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
      expect(startComputerHostProcess).not.toHaveBeenCalled();
      expect(f.leases).toHaveLength(0);
    },
  );
});
