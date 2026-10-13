import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  INSTANCE_BINDING_PROBE_METHOD,
  installInstanceBindingProbeCoordinator,
  writeChannelBindingProbePlugin,
  writeInstanceBindingProbePlugin,
  withPluginServiceStopDeadline,
  type InstanceBindingProbeCoordinator,
  type ChannelBindingProof,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import { type connectWebchatClient, rpcReq } from "./test-helpers.server.js";

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
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  const config = {
    plugins: {
      enabled: true,
      allow: [
        "instance-binding-probe",
        ...(options?.channels ? ["instance-binding-channels"] : []),
      ],
      entries: {
        "instance-binding-probe": { enabled: true },
        ...(options?.channels ? { "instance-binding-channels": { enabled: true } } : {}),
      },
    },
  };
  const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
  expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
    "instance-binding-probe",
  );
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  const restoreChannelRuntimeLoader = coordinator.channelProof
    ? await installChannelBindingRuntimeLoader(coordinator.channelProof)
    : undefined;
  return { coordinator, bundledRoot, configPath, restoreChannelRuntimeLoader };
}

async function installChannelBindingRuntimeLoader(proof: ChannelBindingProof) {
  // Keep the real host factory in Vitest's module graph; fixture plugins still
  // load normally, with their original registry and instance runtime options.
  const [loaderModule, sdkAlias, fullRuntime] = await Promise.all([
    import("../plugins/loader-module-runtime.js"),
    import("../plugins/sdk-alias.js"),
    import("../plugins/runtime/index.js"),
  ]);
  const observation = {
    phase: "runtime-module-loader",
    resolvedTargets: [] as string[],
    factoryCalls: 0,
  };
  proof.observations.push(observation);
  const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
  const createLoader = loaderModule.createPluginModuleLoader;
  const loaderSpy = vi
    .spyOn(loaderModule, "createPluginModuleLoader")
    .mockImplementation((loaderOptions) => {
      const load = createLoader(loaderOptions);
      return (modulePath, owner) => {
        if (!owner && modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath) {
          observation.resolvedTargets.push(modulePath);
          return {
            createPluginRuntime: (...args: Parameters<typeof fullRuntime.createPluginRuntime>) => {
              observation.factoryCalls += 1;
              return fullRuntime.createPluginRuntime(...args);
            },
          };
        }
        return load(modulePath, owner);
      };
    });
  return () => {
    loaderSpy.mockRestore();
    resolveRuntime.mockRestore();
  };
}

export async function patchInstanceBindingTestConfig(
  socket: Awaited<ReturnType<typeof connectWebchatClient>>,
) {
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
    const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    const facades = await Promise.all([import("../config/io.js"), import("../config/config.js")]);
    // Cached mutation importers retain the shared mocks; delegate those same exports to real IO
    // so config receipts, preflight, source snapshots, and runtime defaults keep their real owner.
    for (const facade of facades) {
      configIoRestorers.push(
        vi.spyOn(facade, "createConfigIO").mockImplementation(actualIo.createConfigIO),
        vi.spyOn(facade, "getRuntimeConfig").mockImplementation(actualIo.getRuntimeConfig),
        vi
          .spyOn(facade, "readConfigFileSnapshot")
          .mockImplementation(actualIo.readConfigFileSnapshot),
        vi
          .spyOn(facade, "readConfigFileSnapshotWithPluginMetadata")
          .mockImplementation(actualIo.readConfigFileSnapshotWithPluginMetadata),
        vi
          .spyOn(facade, "readConfigFileSnapshotForWrite")
          .mockImplementation(actualIo.readConfigFileSnapshotForWrite),
        vi.spyOn(facade, "writeConfigFile").mockImplementation(actualIo.writeConfigFile),
      );
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
  socket: Awaited<ReturnType<typeof connectWebchatClient>>;
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
        rpcReq(socket, "plugins.reload", {
          plugins: [{ pluginId: "instance-binding-probe" }],
        }).then((result) => {
          reloadSettled = true;
          return result;
        }),
      async () => {
        expect(reloadSettled).toBe(false);
        expect(coordinator.serviceStops).toBe(1);
        expect(coordinator.serviceStarts).toBe(1);
        expect(coordinator.runtimes).toHaveLength(initialRegistrationCount);
        expect(coordinator.gatewayStops).toEqual([]);
        expect(initialInstance?.disposing).toBe(false);
        expect(initialInstance?.acceptingCalls).toBe(false);
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
