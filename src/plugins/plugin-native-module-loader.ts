import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import { registerCapturedPluginModuleResolver } from "./native-module-require.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import { withPluginCache, type getPluginCache } from "./plugin-cache.js";
import type { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { isPluginSdkAliasSpecifier } from "./sdk-alias.js";

/** Native adapters acquire source through the instance's artifact without replacing evaluation. */
export function bindNativePluginInstanceModuleLoader(
  params: {
    instance: PluginModuleLoaderOwner;
    rootDir: string;
    origin: PluginOrigin;
    standalone?: boolean;
    inputBoundaryRoot?: string;
  },
  cache: ReturnType<typeof getPluginCache>,
  artifact: ReturnType<typeof capturePluginGenerationArtifact>,
  loader: PluginModuleLoader,
  sdkRoots: readonly string[],
): void {
  const hostSdkTarget = (request: string, originalParent?: string) => {
    const target = request.startsWith("file:")
      ? fileURLToPath(request)
      : request.startsWith(".") && originalParent
        ? path.resolve(path.dirname(originalParent), request)
        : request;
    return path.isAbsolute(target) && sdkRoots.some((root) => isPathInside(root, target))
      ? target
      : undefined;
  };
  params.instance.lifecycle.onDispose(
    registerCapturedPluginModuleResolver({
      prepare(request, parent) {
        // Resolved URLs and built relative imports retain the selected host SDK's identity.
        const original = artifact.sourceForCaptured(parent);
        const sdkTarget = hostSdkTarget(request, original);
        if (sdkTarget) {
          return sdkTarget === request ? undefined : sdkTarget;
        }
        const source = original
          ? parent
          : artifact.sourceForCaptured(request)
            ? request
            : undefined;
        if (!source) {
          return undefined;
        }
        return withPluginCache(cache, () => {
          artifact.prepareModule(source);
          if (source === parent && request.startsWith(".")) {
            artifact.captureModule(parent, request, ["node"]);
          }
          const target =
            source === parent && (path.isAbsolute(request) || request.startsWith("file:"))
              ? artifact.captureResolvedModule(
                  request.startsWith("file:") ? fileURLToPath(request) : request,
                )
              : source === request
                ? request
                : undefined;
          if (target) {
            artifact.prepareModule(target);
          }
          artifact.prepareNativeScopes(target ?? source);
          return target;
        });
      },
      resolve(request, parent, resolve) {
        const original = artifact.sourceForCaptured(parent);
        if (!original || isPluginSdkAliasSpecifier(request) || isBuiltin(request)) {
          return undefined;
        }
        const sdkTarget = hostSdkTarget(request, original);
        if (sdkTarget) {
          return sdkTarget;
        }
        return params.instance.run(() =>
          withPluginCache(cache, () => {
            artifact.prepareModule(parent);
            const packageMap = artifact.prepareNativeModule(parent, request);
            // Native createRequire can select Bun/custom conditions that Jiti does not use.
            // Capture the selected file; never substitute a guessed package-map branch.
            let selected: string | undefined;
            try {
              selected = resolve();
            } catch (error) {
              if (
                packageMap ||
                !(error instanceof Error) ||
                !("code" in error) ||
                (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_MODULE_NOT_FOUND")
              ) {
                throw error;
              }
            }
            if (selected) {
              if (hostSdkTarget(selected)) {
                return selected;
              }
              const captured = artifact.captureResolvedModule(selected);
              if (captured) {
                artifact.prepareModule(captured);
                artifact.prepareNativeScopes();
              }
              return captured;
            }
            const captured = artifact.captureModule(parent, request, ["node", "require"]);
            return captured && "target" in captured ? fileURLToPath(captured.target) : undefined;
          }),
        );
      },
    }),
  );
  const boundaryRoot = (params.standalone && params.inputBoundaryRoot) || params.rootDir;
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: params.origin,
    rootDir: boundaryRoot,
  });
  params.instance.bindModuleLoader(
    (source) =>
      withPluginCache(cache, () => {
        const captured = artifact.resolve(source, rejectHardlinks);
        artifact.prepareModule(captured);
        artifact.prepareNativeScopes(captured);
        return loader(toSafeImportPath(captured));
      }),
    artifact.hasSource,
  );
}
