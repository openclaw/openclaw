import { afterEach, beforeEach, expect, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  INSTANCE_BINDING_PROBE_METHOD,
  type ChannelBindingProof,
  type InstanceBindingProbeResult,
} from "./server-plugins.lifecycle.test-fixtures.js";
import { type connectWebchatClient, rpcReq } from "./test-helpers.server.js";

export async function installChannelBindingRuntimeLoader(proof: ChannelBindingProof) {
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
