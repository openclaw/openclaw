import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished as registerTestCleanup, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configFileSource from "../config/source-file.js";
import { markGatewayRestartHandled } from "../infra/restart.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { createWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  CHANNEL_BINDING_IDS,
  clearInstanceBindingProbeCoordinators,
  INSTANCE_BINDING_PROBE_METHOD,
  type ChannelBindingProof,
  type InstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  prepareInstanceBindingFixture,
  installInstanceBindingConfigIo,
  patchInstanceBindingTestConfig,
  requireBoundRuntime,
  requestInstanceBindingProbe as readProbe,
  requestSettledInstanceBindingProbe as settledProbe,
  reloadInstanceBindingAfterServiceDeadline,
} from "./server-plugins.lifecycle.test-support.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Remove the shared helper's loader mock after its import so these fixtures register real plugins.
vi.doUnmock("../plugins/loader.js");

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let restoreChannelRuntimeLoader: (() => void) | undefined;

async function prepareBinding(options?: Parameters<typeof prepareInstanceBindingFixture>[1]) {
  const fixture = await prepareInstanceBindingFixture(
    tempDirs.make("openclaw-instance-binding-"),
    options,
  );
  restoreChannelRuntimeLoader = fixture.restoreChannelRuntimeLoader;
  return fixture;
}

installInstanceBindingConfigIo();

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];
  const finishServiceStops: Array<() => void> = [];

  async function startServer(options: Parameters<typeof startTestGatewayServer>[1]) {
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const server = await startTestGatewayServer(claim, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      ...options,
    });
    started.push(server);
    return { server, port: claim.port };
  }

  async function connectAdmin(port: number) {
    const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    sockets.push(socket);
    return socket;
  }

  async function expectReplacement(
    coordinator: InstanceBindingProbeCoordinator,
    since: number,
    previous: InstanceBindingProbeResult,
  ) {
    const { runtime } = await requireBoundRuntime(
      coordinator.runtimes.filter(
        (_runtime, index) => index >= since && coordinator.registrationModes[index] === "full",
      ),
      "replacement",
    );
    const probe = await readProbe(runtime);
    expect(probe.registryId).not.toBe(previous.registryId);
    expect(probe).toMatchObject(bindingIds(previous));
  }

  const bindingIds = ({ sessionsId, placementId }: InstanceBindingProbeResult) => ({
    sessionsId,
    placementId,
  });

  let channelProof: ChannelBindingProof | undefined;
  let channelEnv: ReturnType<typeof captureEnv> | undefined;

  afterEach(async () => {
    // Reopen synthetic recovery's admission fence before joining background work.
    markGatewayRestartHandled();
    // Finish the original stop after observing its replacement deadline.
    for (const finish of finishServiceStops.splice(0)) {
      finish();
    }
    const closingSockets = sockets.splice(0);
    const socketClosures = closingSockets.map((socket) =>
      socket.readyState === socket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
          }),
    );
    const closeFailures: unknown[] = [];
    try {
      for (const socket of closingSockets) {
        socket.close();
      }
      for (const server of started.splice(0).toReversed()) {
        try {
          await server.close({ reason: "instance binding cleanup" });
        } catch (error) {
          closeFailures.push(error);
        }
      }
      await Promise.all(socketClosures);
    } finally {
      restoreChannelRuntimeLoader?.();
      restoreChannelRuntimeLoader = undefined;
      channelEnv?.restore();
      channelEnv = undefined;
      clearInstanceBindingProbeCoordinators();
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      if (channelProof) {
        const proof = channelProof;
        channelProof = undefined;
        expect
          .soft(proof.monitors.every((monitor) => monitor.stopped && monitor.abortSignal.aborted))
          .toBe(true);
      }
    }
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, "Gateway lifecycle fixture shutdown failed");
    }
  });

  it("discards startup preparation overtaken by close", { timeout: 600_000 }, async () => {
    const { coordinator } = await prepareBinding();
    const kernelModule = await import("./server-kernel.js");
    const createKernel = kernelModule.createGatewayKernel;
    const prepared = createDeferred();
    const release = createDeferred();
    const lifecycleEvents: Array<
      Parameters<NonNullable<InstanceBindingProbeCoordinator["onLifecycleEvent"]>>[0]
    > = [];
    coordinator.onLifecycleEvent = (event) => lifecycleEvents.push(event);
    const kernelSpy = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementationOnce(async (...args) => {
        const kernel = await createKernel(...args);
        const prepare = kernel.prepareAttachedPluginRuntime;
        return {
          ...kernel,
          prepareAttachedPluginRuntime: async (...prepareArgs) => {
            const attachment = await prepare(...prepareArgs);
            prepared.resolve();
            await release.promise;
            return attachment;
          },
        };
      });
    try {
      const { server } = await startServer({ sidecarStartup: "defer" });
      await prepared.promise;
      const closing = server.close({ reason: "close during startup preparation" });
      release.resolve();
      await Promise.all([closing, server.startupSettled]);
      expect(lifecycleEvents).toEqual([]);
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
      expect(coordinator.runtimes.length).toBeGreaterThan(0);
      for (const runtime of coordinator.runtimes) {
        expect(await runtime.gateway.isAvailable()).toBe(false);
      }
    } finally {
      release.resolve();
      kernelSpy.mockRestore();
    }
  });

  it("renews channels only when their owner reloads", { timeout: 600_000 }, async () => {
    const { coordinator, configPath, bundledRoot } = await prepareBinding({ channels: true });
    const createConfigFileAdapter = configFileSource.createConfigFileAdapter;
    const configWatcher = vi
      .spyOn(configFileSource, "createConfigFileAdapter")
      .mockImplementation((options) => {
        if (options.path !== configPath) {
          return createConfigFileAdapter(options);
        }
        // Explicit config writes own this case; filesystem echoes can race the next RPC.
        const watcher = createWatcherMock();
        const adapter = watcher.attach(options);
        return {
          ...adapter,
          async start() {
            await adapter.start();
            queueMicrotask(() => watcher.emit("ready"));
          },
        };
      });
    registerTestCleanup(() => configWatcher.mockRestore());
    const proof = coordinator.channelProof;
    if (!proof) {
      throw new Error("channel binding fixture was not installed");
    }
    channelProof = proof;
    channelEnv = captureEnv(["OPENCLAW_SKIP_CHANNELS", "OPENCLAW_SKIP_PROVIDERS"]);
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
    const { server, port } = await startServer({ hotReloadRecovery, sidecarStartup: "start" });
    await server.startupSettled;
    await expect.poll(() => proof.monitors.length, { timeout: 30_000 }).toBe(2);
    const initialMonitors = [...proof.monitors];
    expect(initialMonitors.map((monitor) => monitor.channelId).toSorted()).toEqual([
      ...CHANNEL_BINDING_IDS,
    ]);
    const initialProbes = await Promise.all(
      initialMonitors.map((monitor) => settledProbe(monitor.runtime)),
    );
    expect(initialProbes[0]).toEqual(initialProbes[1]);
    const { runtime: initialProbeRuntime } = await requireBoundRuntime(
      coordinator.runtimes,
      "initial probe owner",
    );
    const startupMetadata = getGatewayPluginMetadataSnapshot();
    expect(startupMetadata?.byPluginId.get("instance-binding-probe")?.name).toBe("Startup plugin");
    const manifestPath = path.join(bundledRoot, "instance-binding-probe", "openclaw.plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: "Changed plugin" }));
    expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
    const registrationsBeforeReload = coordinator.runtimes.length;
    let reloadEventIndex = proof.events.length;
    const socket = await connectAdmin(port);
    const reload = await patchInstanceBindingTestConfig(socket);
    expect(reload.ok, reload.error?.message).toBe(true);
    expect(reload.payload).toMatchObject({
      sentinel: { payload: { stats: { requiresRestart: false } } },
    });
    await expect
      .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
      .toBeGreaterThan(registrationsBeforeReload);
    const { runtime: freshRuntime } = await requireBoundRuntime(
      coordinator.runtimes.slice(registrationsBeforeReload),
      "reloaded",
    );
    const freshProbe = await settledProbe(freshRuntime);
    expect(getGatewayPluginMetadataSnapshot()).not.toBe(startupMetadata);
    expect(getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name).toBe(
      "Changed plugin",
    );
    await expect(
      freshRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
    ).resolves.toEqual({ messages: [] });
    expect(freshProbe.registryId).not.toBe(initialProbes[0]!.registryId);
    expect(freshProbe).toMatchObject(bindingIds(initialProbes[0]!));
    expect(hotReloadRecovery).not.toHaveBeenCalled();
    await expect(readProbe(initialProbeRuntime)).rejects.toThrow(
      'Plugin "instance-binding-probe" runtime is no longer active.',
    );
    expect(proof.monitors).toEqual(initialMonitors);
    for (const monitor of initialMonitors) {
      expect(monitor).toMatchObject({ stopped: false, abortSignal: { aborted: false } });
      await expect(settledProbe(monitor.runtime)).resolves.toEqual(freshProbe);
    }
    expect(
      proof.events
        .slice(reloadEventIndex)
        .filter((event) =>
          ["start", "stopped", "stop-aborted", "stop-unaborted"].includes(event.event),
        ),
    ).toEqual([]);

    // Reload the channel owner itself to distinguish retained capabilities from stale ones.
    reloadEventIndex = proof.events.length;
    const registryBeforeChannelReload = getActivePluginRegistry();
    const channelOwner = registryBeforeChannelReload?.plugins.find(
      (record) => record.id === "instance-binding-channels",
    );
    const channelInstance = channelOwner && getPluginInstance(channelOwner);
    expect(channelInstance?.hasRetainedConsumers).toBe(true);
    // Live monitors retain custody, so they cannot refuse replacement admission.
    expect(() => channelInstance!.reserveReplacement()).not.toThrow();
    const channelReload = await rpcReq(socket, "plugins.reload", {
      plugins: [{ pluginId: "instance-binding-channels" }],
    });
    expect(channelReload.ok, channelReload.error?.message).toBe(true);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
    expect(getActivePluginRegistry()).not.toBe(registryBeforeChannelReload);
    for (const monitor of initialMonitors) {
      expect(monitor).toMatchObject({ stopped: true, abortSignal: { aborted: true } });
    }
    // The receipt completes this reload; wait separately for global config settlement.
    await settledProbe(freshRuntime);
    const currentProbe = await rpcReq<InstanceBindingProbeResult>(
      socket,
      INSTANCE_BINDING_PROBE_METHOD,
      {},
    );
    expect(currentProbe.ok, currentProbe.error?.message).toBe(true);
    const channelProbe = currentProbe.payload;
    if (!channelProbe) {
      throw new Error("channel publication did not return an authoritative probe");
    }
    // The token identifies the retained probe registration, not the registry.
    expect(channelProbe).toEqual({ ...freshProbe, reloadSettled: true });
    await expect(settledProbe(freshRuntime)).resolves.toEqual(channelProbe);
    for (const monitor of initialMonitors) {
      await expect(readProbe(monitor.runtime)).rejects.toThrow(
        'Plugin "instance-binding-channels" runtime is no longer active.',
      );
    }
    await expect
      .poll(
        () =>
          proof.monitors
            .filter((monitor) => !monitor.stopped)
            .map((monitor) => monitor.channelId)
            .toSorted(),
        { timeout: 30_000 },
      )
      .toEqual([...CHANNEL_BINDING_IDS]);
    await Promise.all(
      initialMonitors.map(async (initial) => {
        const active = proof.monitors.filter(
          (monitor) => monitor.channelId === initial.channelId && !monitor.stopped,
        );
        expect(active).toHaveLength(1);
        const monitor = active[0]!;
        expect(monitor.runtime).not.toBe(initial.runtime);
        await expect(readProbe(monitor.runtime)).resolves.toMatchObject({
          registryId: channelProbe.registryId,
        });
        const events = proof.events
          .slice(reloadEventIndex)
          .filter((entry) => entry.channelId === initial.channelId);
        const eventIndex = (event: string, runtimeId: number) =>
          events.findIndex((entry) => entry.event === event && entry.runtimeId === runtimeId);
        const stoppedAt = eventIndex("stopped", initial.runtimeId);
        const registeredAt = eventIndex("register", monitor.runtimeId);
        const startedAt = eventIndex("start", monitor.runtimeId);
        expect(Math.min(stoppedAt, registeredAt)).toBeGreaterThanOrEqual(0);
        expect(startedAt).toBeGreaterThan(Math.max(stoppedAt, registeredAt));
      }),
    );
  });

  it.each(["rejection", "timeout"] as const)(
    "keeps Gateway available after %s cleanup refuses replacement",
    { timeout: 600_000 },
    async (serviceStopFailure) => {
      const { coordinator, bundledRoot } = await prepareBinding({ serviceStopFailure });
      const startupPlugins = await import("./server-startup-plugins.js");
      const runMaintenance = startupPlugins.runGatewayPostReadyStartupMaintenance;
      const maintenanceSettled = createDeferred();
      const maintenanceObserver = vi
        .spyOn(startupPlugins, "runGatewayPostReadyStartupMaintenance")
        .mockImplementation((params) => {
          const maintenance = runMaintenance(params);
          maintenanceSettled.resolve(maintenance);
          return maintenance;
        });
      registerTestCleanup(() => maintenanceObserver.mockRestore());
      finishServiceStops.push(coordinator.serviceStopCompletion.resolve);
      const hotReloadRecovery = vi.fn(() => {
        // No run loop consumes this synthetic emission, so release its signal-admission lease.
        markGatewayRestartHandled();
        return { status: "emitted" as const };
      });
      const { server, port } = await startServer({ hotReloadRecovery, sidecarStartup: "start" });
      await server.startupSettled;
      // Mandatory sidecars settle before the deferred registry refresh releases its lease.
      await maintenanceSettled.promise;

      const initialRegistry = getActivePluginRegistry();
      const initialMetadata = getGatewayPluginMetadataSnapshot();
      const initialRegistrationCount = coordinator.runtimes.length;
      const expectNoGatewayReplacement = () => {
        // Model-runtime rollback may prepare auxiliary registries without activating a Gateway.
        expect(
          coordinator.registrationModes
            .slice(initialRegistrationCount)
            .every((mode) => mode === "discovery"),
        ).toBe(true);
      };
      expect(initialRegistry).toBeDefined();
      expect(initialMetadata).toBeDefined();
      expect(coordinator.serviceStarts).toBe(1);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await readProbe(initialRuntime);

      const socket = await connectAdmin(port);
      const currentConfig = await rpcReq(socket, "config.get", {});
      expect(currentConfig).toMatchObject({
        ok: true,
        payload: { hash: expect.any(String), raw: expect.any(String) },
      });
      const initialInstance = initialRegistry?.plugins
        .filter((record) => record.id === "instance-binding-probe")
        .map(getPluginInstance)[0];
      const reload = await reloadInstanceBindingAfterServiceDeadline({
        coordinator,
        bundledRoot,
        socket,
        currentConfig,
      });
      expect(reload, reload.error?.message).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "drain" } } },
      });
      expect(reload.error?.message).toContain(
        serviceStopFailure === "rejection"
          ? "instance-binding service cleanup rejected"
          : "timed out",
      );
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      expect(coordinator.serviceStops).toBe(1);
      const recovered = serviceStopFailure === "timeout";
      expect(coordinator.serviceStarts).toBe(recovered ? 2 : 1);
      expect(getGatewayPluginMetadataSnapshot()).toBe(initialMetadata);
      if (recovered) {
        expect(initialInstance?.disposing).toBe(true);
        expect(coordinator.gatewayStops).toEqual([initialProbe.registryId]);
        expect(getActivePluginRegistry()).not.toBe(initialRegistry);
        await expectReplacement(coordinator, initialRegistrationCount, initialProbe);
      } else {
        expectNoGatewayReplacement();
        expect(getActivePluginRegistry()).toBe(initialRegistry);
      }
      await expect(readProbe(initialRuntime)).rejects.toThrow(
        'Plugin "instance-binding-probe" runtime is no longer active.',
      );
      const afterReload = await rpcReq(socket, "config.get", {});
      expect(afterReload).toMatchObject({
        ok: true,
        payload: { hash: currentConfig.payload?.hash, raw: currentConfig.payload?.raw },
      });

      const beforeRetryRegistrations = coordinator.runtimes.length;
      const retry = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      if (serviceStopFailure === "timeout") {
        expect(retry, retry.error?.message).toMatchObject({
          ok: true,
          payload: { restartRequired: false },
        });
        expect(coordinator.serviceStarts).toBe(3);
        await expectReplacement(coordinator, beforeRetryRegistrations, initialProbe);
      } else {
        expect(retry.ok).toBe(false);
        expect(retry.error?.message).toContain("instance-binding service cleanup rejected");
        expectNoGatewayReplacement();
        expect(coordinator.serviceStarts).toBe(1);
      }
      await server.close({ reason: "close after plugin cleanup refusal" });
      started.splice(started.indexOf(server), 1);
      expect(coordinator.serviceStops).toBe(serviceStopFailure === "timeout" ? 3 : 1);
    },
  );
});
