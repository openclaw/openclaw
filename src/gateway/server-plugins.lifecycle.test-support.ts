import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  INSTANCE_BINDING_PROBE_METHOD,
  clearInstanceBindingProbeCoordinators,
  installInstanceBindingProbeCoordinator,
  writeChannelBindingProbePlugin,
  writeInstanceBindingProbePlugin,
  withPluginServiceStopDeadline,
  type InstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  type connectWebchatClient,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

export type PluginSocket = Awaited<ReturnType<typeof connectWebchatClient>>;
export type PluginServer = Awaited<ReturnType<typeof startTestGatewayServer>>;
export const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value));

export const reloadPlugin = (
  socket: PluginSocket,
  pluginId = "instance-binding-probe",
  timeoutMs?: number,
) => rpcReq(socket, "plugins.reload", { plugins: [{ pluginId }] }, timeoutMs);

export function configurePluginGateway(bundledRoot: string, channels = false) {
  Object.assign(process.env, {
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_SKIP_CRON: "1",
  });
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  if (channels) {
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
  } else {
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  return configPath;
}

export async function startPluginGateway(options: Parameters<typeof startTestGatewayServer>[1]) {
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startTestGatewayServer(claim, {
    auth: { mode: "none" },
    controlUiEnabled: false,
    sidecarStartup: "start",
    ...options,
  });
  return { server, port: claim.port };
}

// Manual reloads must wait for post-ready maintenance to release the lifecycle lease.
export async function observePostReadyStartupMaintenance() {
  const startupPlugins = await import("./server-startup-plugins.js");
  const run = startupPlugins.runGatewayPostReadyStartupMaintenance;
  const settled = createDeferredCore();
  const observer = vi
    .spyOn(startupPlugins, "runGatewayPostReadyStartupMaintenance")
    .mockImplementation((params) => {
      const maintenance = run(params);
      maintenance.then(settled.resolve, settled.resolve);
      return maintenance;
    });
  onTestFinished(() => observer.mockRestore());
  return { settled: settled.promise };
}

export async function closePluginGateway(server: PluginServer | undefined, socket?: PluginSocket) {
  const closed =
    !socket || socket.readyState === socket.CLOSED
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });
  socket?.close();
  try {
    const results = await Promise.allSettled([
      server?.close({ reason: "plugin fixture cleanup" }),
      closed,
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Plugin lifecycle fixture shutdown failed");
    }
  } finally {
    clearInstanceBindingProbeCoordinators();
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  }
}

export async function prepareInstanceBindingFixture(
  bundledRoot: string,
  options?: {
    serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
    channels?: boolean;
    channelIds?: readonly string[];
  },
) {
  const coordinator = installInstanceBindingProbeCoordinator(options);
  await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName);
  if (options?.channels) {
    await writeChannelBindingProbePlugin(bundledRoot, coordinator.channelName, options.channelIds);
  }
  const configPath = configurePluginGateway(bundledRoot);
  const pluginIds = [
    "instance-binding-probe",
    ...(options?.channels ? ["instance-binding-channels"] : []),
  ];
  const config = {
    plugins: {
      enabled: true,
      allow: pluginIds,
      entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])),
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  const restoreChannelRuntimeLoader = coordinator.channelProof
    ? await installChannelBindingRuntimeLoader()
    : undefined;
  return { coordinator, bundledRoot, configPath, restoreChannelRuntimeLoader };
}

async function installChannelBindingRuntimeLoader() {
  // Keep the real host factory in Vitest's module graph; fixture plugins still
  // load normally, with their original registry and instance runtime options.
  const [loaderModule, sdkAlias, fullRuntime] = await Promise.all([
    import("../plugins/loader-module-runtime.js"),
    import("../plugins/sdk-alias.js"),
    import("../plugins/runtime/index.js"),
  ]);
  const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
  const createLoader = loaderModule.createPluginModuleLoader;
  const loaderSpy = vi
    .spyOn(loaderModule, "createPluginModuleLoader")
    .mockImplementation((loaderOptions) => {
      const load = createLoader(loaderOptions);
      return Object.assign(
        (modulePath: Parameters<typeof load>[0], owner: Parameters<typeof load>[1]) => {
          if (!owner && modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath) {
            return { createPluginRuntime: fullRuntime.createPluginRuntime };
          }
          return load(modulePath, owner);
        },
        { prepare: (...args: Parameters<typeof load.prepare>) => load.prepare(...args) },
      );
    });
  return () => {
    loaderSpy.mockRestore();
    resolveRuntime.mockRestore();
  };
}

export async function patchInstanceBindingTestConfig(socket: PluginSocket) {
  const current = await rpcReq<{ hash?: string }>(socket, "config.get", {});
  expect(current.ok).toBe(true);
  expect(current.payload?.hash).toBeTypeOf("string");
  return await rpcReq(socket, "config.patch", {
    raw: JSON.stringify({
      plugins: {
        entries: {
          "instance-binding-probe": { subagent: { allowModelOverride: true } },
        },
      },
    }),
    baseHash: current.payload?.hash,
  });
}

export function installInstanceBindingConfigIo() {
  const configIoRestorers: Array<{ mockRestore: () => void }> = [];

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const facades = await Promise.all([import("../config/io.js"), import("../config/config.js")]);
    // Cached mutation importers retain the shared mocks; delegate those same exports to real IO
    // so config receipts, preflight, source snapshots, and runtime defaults keep their real owner.
    for (const facade of facades) {
      for (const name of [
        "createConfigIO",
        "getRuntimeConfig",
        "readConfigFileSnapshot",
        "readConfigFileSnapshotWithPluginMetadata",
        "readConfigFileSnapshotForWrite",
        "writeConfigFile",
      ] as const) {
        configIoRestorers.push(vi.spyOn(facade, name).mockImplementation(real[name]));
      }
    }
  });

  afterEach(() => {
    for (const restore of configIoRestorers.splice(0)) {
      restore.mockRestore();
    }
  });
}

export async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

export function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}

/** Capture the same reply that confirms config settlement, separate from sidecar startup. */
export async function requestSettledInstanceBindingProbe(
  runtime: PluginRuntime,
): Promise<InstanceBindingProbeResult> {
  return await vi.waitUntil(
    async () => {
      const probe = await requestInstanceBindingProbe(runtime);
      return probe.reloadSettled === true ? probe : false;
    },
    { timeout: 30_000 },
  );
}

/** Exercise pending cleanup through the real RPC before allowing captured-code recovery. */
export async function reloadInstanceBindingAfterServiceDeadline({
  coordinator,
  bundledRoot,
  socket,
  currentConfig,
}: {
  coordinator: InstanceBindingProbeCoordinator;
  bundledRoot: string;
  socket: PluginSocket;
  currentConfig: Awaited<ReturnType<typeof rpcReq>>;
}) {
  const initialRegistry = getActivePluginRegistry();
  const initialMetadata = getGatewayPluginMetadataSnapshot();
  const initialRegistrationCount = coordinator.runtimes.length;
  const initialInstance = initialRegistry?.plugins
    .filter((record) => record.id === "instance-binding-probe")
    .map(getPluginInstance)[0];
  const sourcePath = path.join(bundledRoot, "instance-binding-probe", "index.js");
  const originalSource = await fs.readFile(sourcePath, "utf8");
  let reloadSettled = false;
  try {
    return await withPluginServiceStopDeadline(
      coordinator,
      () =>
        reloadPlugin(socket).then((result) => {
          reloadSettled = true;
          return result;
        }),
      async () => {
        expect(reloadSettled).toBe(false);
        expect(coordinator).toMatchObject({ serviceStops: 1, serviceStarts: 1, gatewayStops: [] });
        expect(coordinator.runtimes).toHaveLength(initialRegistrationCount);
        expect(initialInstance).toMatchObject({ disposing: false, acceptingCalls: false });
        expect(getGatewayPluginMetadataSnapshot()).toBe(initialMetadata);
        expect(getActivePluginRegistry()).toBe(initialRegistry);
        const pendingConfig = await rpcReq(socket, "config.get", {});
        expect(pendingConfig.ok).toBe(true);
        expect(pendingConfig.payload).toMatchObject({
          hash: currentConfig.payload?.hash,
          raw: currentConfig.payload?.raw,
        });
        // Bundled recovery must retain process code identity, not reread replacement bytes.
        await fs.writeFile(sourcePath, 'throw new Error("replacement must not run");\n');
      },
    );
  } finally {
    await fs.writeFile(sourcePath, originalSource);
  }
}
