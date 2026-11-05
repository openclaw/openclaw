import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import {
  registerCapturedPluginModuleResolver,
  type BunPluginRuntime,
} from "./native-module-require.js";
import type { PluginModuleLoader } from "./plugin-cache-artifacts.js";
import { withPluginCache, type PluginCache } from "./plugin-cache.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";
import { getPluginBunConditions } from "./plugin-native-resolution.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePluginNativeAliasForParent } from "./plugin-sdk-native-resolver.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { resolvePluginPackageMapTarget } from "./plugin-source-references.js";
import { isPluginSdkAliasSpecifier } from "./sdk-alias.js";
import { recordPluginSdkDeprecatedImport } from "./sdk-deprecated-imports.js";

/** Native adapters acquire source through the instance's artifact without replacing evaluation. */
export function bindNativePluginInstanceModuleLoader(
  params: {
    instance: PluginModuleLoaderOwner;
    rootDir: string;
    origin: PluginOrigin;
    bindModuleLoader: PluginModuleLoaderOwner["bindModuleLoader"];
    ownsResolution?: () => boolean;
    moduleFacade?: string;
    moduleHelpers?: string;
    moduleSource?: (filename: string) => string;
    prepareSource?: (filename: string) => string;
  },
  cache: PluginCache,
  artifact: PluginGenerationArtifact,
  loader: PluginModuleLoader,
  sdkRoots: readonly string[],
  prepareEntryNativeScopes: boolean,
): void {
  const bun: BunPluginRuntime | undefined = Reflect.get(globalThis, "Bun");
  const jitiJsx = process.env.JITI_JSX;
  const jsxEnabled = jitiJsx === "1" || jitiJsx === "true";
  const jsxTranspilers = new Map<"jsx" | "tsx", { transformSync(source: string): string }>();
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
  params.instance.onModuleDispose(
    registerCapturedPluginModuleResolver({
      ...(jsxEnabled && bun
        ? {
            load(request: string) {
              if (params.ownsResolution && !params.ownsResolution()) {
                return undefined;
              }
              if (!artifact.sourceForCaptured(params.moduleSource?.(request) ?? request)) {
                return undefined;
              }
              const extension = path.extname(request).toLowerCase();
              const sourceLoader = extension === ".jsx" ? "jsx" : "tsx";
              let transpiler = jsxTranspilers.get(sourceLoader);
              if (!transpiler) {
                transpiler = new bun.Transpiler({
                  loader: sourceLoader,
                  tsconfig: {
                    compilerOptions: {
                      jsx: "react" as const,
                      jsxFactory: "React.createElement",
                      jsxFragmentFactory: "React.Fragment",
                    },
                  },
                });
                jsxTranspilers.set(sourceLoader, transpiler);
              }
              return {
                contents: transpiler.transformSync(fs.readFileSync(request, "utf8")),
                loader: "js" as const,
              };
            },
          }
        : {}),
      prepare(request, requestedParent, kind) {
        const parent = params.moduleSource?.(requestedParent) ?? requestedParent;
        if (params.ownsResolution && !params.ownsResolution()) {
          return undefined;
        }
        // Host imports do not belong to this capture and must not enter its worker.
        const requestedPath = request.startsWith("file:") ? fileURLToPath(request) : request;
        if (
          !isPathInside(artifact.boundaryRoot, parent) &&
          (!path.isAbsolute(requestedPath) || !isPathInside(artifact.boundaryRoot, requestedPath))
        ) {
          return undefined;
        }
        // Resolved URLs and built relative imports retain the selected host SDK's identity.
        const original = artifact.sourceForCaptured(parent);
        if (
          original &&
          params.moduleFacade &&
          (request === "module" || request === "node:module" || request === params.moduleFacade)
        ) {
          return params.moduleFacade;
        }
        if (original && request === params.moduleHelpers) {
          return params.moduleHelpers;
        }
        if (isBuiltin(request)) {
          return undefined;
        }
        const sdkTarget = hostSdkTarget(request, original);
        if (sdkTarget) {
          return sdkTarget === request ? undefined : sdkTarget;
        }
        if (!original && !artifact.sourceForCaptured(request)) {
          return undefined;
        }
        const source = original ? parent : request;
        return withPluginCache(cache, () => {
          artifact.prepareModule(source);
          // Prefetched entries need their own facts before classifying Bun's require previews.
          const facts = artifact.moduleFacts(parent);
          if (
            kind === "import-statement" &&
            !artifact.frozenSource &&
            facts?.staticImports &&
            !facts.staticImports.has(request)
          ) {
            return undefined;
          }
          // Deferred SDK imports retain their generation's host selection after cache replacement.
          if (source === parent && isPluginSdkAliasSpecifier(request)) {
            const target = resolvePluginNativeAliasForParent(request, parent);
            if (target) {
              recordPluginSdkDeprecatedImport(params.instance.pluginId, request);
            }
            return target;
          }
          let target: string | undefined;
          const requireMode = kind === "require-call" || kind === "require-resolve";
          const conditions = [...getPluginBunConditions(requireMode)];
          if (
            source === parent &&
            !path.isAbsolute(request) &&
            !request.startsWith("file:") &&
            !isBuiltin(request) &&
            !(request.startsWith("#") && facts?.isNativeImportPattern(request))
          ) {
            const captured = artifact.captureModule(
              parent,
              request,
              // Jiti implements computed relative imports through require.resolve.
              request.startsWith(".") &&
                kind === "require-resolve" &&
                !facts?.isRequireReference(request)
                ? ["node", "module-sync", "import"]
                : conditions,
            );
            if (captured && "target" in captured) {
              target =
                captured.target.search || captured.target.hash
                  ? captured.target.href
                  : fileURLToPath(captured.target);
            } else if (captured && "retryNative" in captured) {
              try {
                const selected = resolvePluginPackageMapTarget(request, parent, conditions);
                if (selected) {
                  const capturedTarget = artifact.captureResolvedModule(fileURLToPath(selected));
                  if (capturedTarget) {
                    const capturedUrl = pathToFileURL(capturedTarget);
                    capturedUrl.search = selected.search;
                    capturedUrl.hash = selected.hash;
                    target =
                      capturedUrl.search || capturedUrl.hash ? capturedUrl.href : capturedTarget;
                  }
                }
              } catch (error) {
                if (error instanceof PluginSnapshotDependencyError) {
                  throw error;
                }
                // Native resolution owns the final error when the request remains unavailable.
              }
            }
          }
          target ??=
            source === parent && (path.isAbsolute(request) || request.startsWith("file:"))
              ? artifact.captureResolvedModule(
                  request.startsWith("file:") ? fileURLToPath(request) : request,
                )
              : source === request
                ? request
                : undefined;
          if (!target && artifact.frozenSource) {
            const selected = bun?.resolveSync?.(request, path.dirname(parent));
            if (!selected) {
              throw new PluginSnapshotDependencyError(request);
            }
            artifact.assertFrozenModule?.(selected);
            target = artifact.captureResolvedModule(selected);
            if (!target) {
              throw new PluginSnapshotDependencyError(selected);
            }
          }
          if (target) {
            artifact.assertFrozenModule?.(
              target.startsWith("file:") ? fileURLToPath(target) : target,
            );
            artifact.prepareModule(target.startsWith("file:") ? fileURLToPath(target) : target);
          }
          if (original) {
            artifact.prepareNativeScopes(
              target?.startsWith("file:") ? fileURLToPath(target) : (target ?? source),
            );
          }
          if (!target || !params.prepareSource) {
            return target;
          }
          const url = target.startsWith("file:") ? new URL(target) : undefined;
          const prepared = params.prepareSource(url ? fileURLToPath(url) : target);
          if (url) {
            url.pathname = pathToFileURL(prepared).pathname;
            return url.href;
          }
          return prepared;
        });
      },
      resolve(request, parent, resolve) {
        if (params.ownsResolution && !params.ownsResolution()) {
          return undefined;
        }
        const original = artifact.sourceForCaptured(parent);
        if (
          original &&
          params.moduleFacade &&
          (request === "module" || request === "node:module" || request === params.moduleFacade)
        ) {
          return params.moduleFacade;
        }
        if (!original || isBuiltin(request)) {
          return undefined;
        }
        if (isPluginSdkAliasSpecifier(request)) {
          const target = resolve();
          recordPluginSdkDeprecatedImport(params.instance.pluginId, request);
          return target;
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
              artifact.assertFrozenModule?.(selected);
              const captured = artifact.captureResolvedModule(selected);
              if (!captured && artifact.frozenSource) {
                throw new PluginSnapshotDependencyError(selected);
              }
              if (captured) {
                artifact.prepareModule(captured);
                artifact.prepareNativeScopes();
              }
              return captured;
            }
            const captured = artifact.captureModule(parent, request, [
              "node",
              "module-sync",
              "require",
            ]);
            if (artifact.frozenSource && (!captured || !("target" in captured))) {
              throw new PluginSnapshotDependencyError(request);
            }
            return captured && "target" in captured ? fileURLToPath(captured.target) : undefined;
          }),
        );
      },
    }),
  );
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: params.origin,
    rootDir: params.rootDir,
  });
  params.bindModuleLoader(
    (source) =>
      withPluginCache(cache, () => {
        const captured = artifact.resolve(source, rejectHardlinks);
        artifact.prepareModule(captured);
        if (prepareEntryNativeScopes) {
          artifact.prepareNativeScopes(captured);
        }
        return loader(toSafeImportPath(params.prepareSource?.(captured) ?? captured));
      }),
    artifact.hasSource,
  );
}
