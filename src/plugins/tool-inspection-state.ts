import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-state.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

export const inspectionToolOwners = new WeakMap<
  PluginRegistry,
  {
    manifests: ReadonlyMap<string, PluginManifestRecord>;
    assertCurrent: () => void;
    withSupplementalCache: <T>(run: () => T) => T;
  }
>();

export function createPluginToolInspection(
  acquisition: { registry: PluginRegistry; release: () => Promise<void> },
  manifests: ReadonlyMap<string, PluginManifestRecord>,
) {
  const current = capturePluginLifecycleAuthority(acquisition.registry, undefined, {
    scopedRuntime: true,
  });
  let supplementalCache: PluginCache | undefined;
  let release: Promise<void> | undefined;
  const assertCurrent = () => {
    if (release || !current?.()) {
      throw new Error("Plugin tool inspection has been released");
    }
  };
  inspectionToolOwners.set(acquisition.registry, {
    manifests,
    assertCurrent,
    withSupplementalCache: (run) => {
      assertCurrent();
      return withPluginCache((supplementalCache ??= createPluginCache()), run);
    },
  });
  return {
    registry: acquisition.registry,
    release: () => {
      if (release) {
        return release;
      }
      const completion = createDeferredCore();
      release = completion.promise;
      void Promise.allSettled([
        (async () => await acquisition.release())(),
        (async () => {
          if (supplementalCache) {
            const { failures } = await retirePluginCache(supplementalCache);
            if (failures.length === 1) {
              throw failures[0]!.error;
            }
            if (failures.length > 0) {
              throw new AggregateError(
                failures.map((failure) => failure.error),
                "Supplemental plugin inspection cleanup failed",
              );
            }
          }
        })(),
      ])
        .then((cleanup) => {
          const failures = cleanup.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, "Plugin tool inspection cleanup failed");
          }
        })
        .then(completion.resolve, completion.reject);
      return release;
    },
  };
}

export function getCurrentPluginToolInspection(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
  workspaceDir?: string,
) {
  const registry =
    getPluginRuntimeGenerationRegistry() ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const inspection = registry && inspectionToolOwners.get(registry);
  const loadContext = inspection && getPluginRuntimeLoadContext(registry);
  if (
    !registry ||
    !inspection ||
    loadContext?.env !== env ||
    (workspaceDir !== undefined && workspaceDir !== loadContext.workspaceDir) ||
    (config !== loadContext.rawConfig &&
      config !== loadContext.config &&
      config !== loadContext.activationSourceConfig)
  ) {
    return undefined;
  }
  inspection.assertCurrent();
  return { registry, inspection, loadContext };
}

export function samePluginToolSource(
  left: PluginManifestRecord | undefined,
  right: PluginManifestRecord | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.origin === right.origin &&
    left.rootDir === right.rootDir &&
    left.source === right.source &&
    left.setupSource === right.setupSource &&
    (left.sourcePreferred === true) === (right.sourcePreferred === true) &&
    (left.packageManifest?.build?.bundledDist === false) ===
      (right.packageManifest?.build?.bundledDist === false),
  );
}
