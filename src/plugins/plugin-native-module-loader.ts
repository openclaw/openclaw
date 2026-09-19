import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
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

function getBunConditions(requireMode: boolean): Set<string> {
  const conditions = new Set(["bun", "node", requireMode ? "require" : "import"]);
  if (!process.execArgv.includes("--no-addons")) {
    conditions.add("node-addons");
  }
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if (argument === "--conditions") {
      const condition = process.execArgv[index + 1];
      if (condition && !condition.startsWith("-")) {
        conditions.add(condition);
        index += 1;
      }
    } else if (argument?.startsWith("--conditions=")) {
      conditions.add(argument.slice("--conditions=".length));
    }
  }
  return conditions;
}

/** Native adapters acquire source through the instance's artifact without replacing evaluation. */
export function bindNativePluginInstanceModuleLoader(
  params: {
    instance: PluginModuleLoaderOwner;
    rootDir: string;
    origin: PluginOrigin;
    bindModuleLoader?: PluginModuleLoaderOwner["bindModuleLoader"];
  },
  cache: ReturnType<typeof getPluginCache>,
  artifact: ReturnType<typeof capturePluginGenerationArtifact>,
  loader: PluginModuleLoader,
  sdkRoots: readonly string[],
  prepareEntryNativeScopes: boolean,
): void {
  const bun: import("./native-module-require.js").BunPluginRuntime | undefined = Reflect.get(
    globalThis,
    "Bun",
  );
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
  params.instance.lifecycle.onDispose(
    registerCapturedPluginModuleResolver({
      ...(jsxEnabled && bun
        ? {
            load(request: string) {
              if (!artifact.sourceForCaptured(request)) {
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
      prepare(request, parent, kind) {
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
          let target: string | undefined;
          const requireMode = kind === "require-call" || kind === "require-resolve";
          const conditions = ["node", requireMode ? "require" : "import"];
          if (source === parent && request.startsWith(".")) {
            // Jiti implements computed imports through require.resolve; relative source capture
            // still follows the authored import graph rather than that internal mechanism.
            const captured = artifact.captureModule(parent, request, ["node", "import"]);
            if (captured && "target" in captured) {
              target =
                captured.target.search || captured.target.hash
                  ? captured.target.href
                  : fileURLToPath(captured.target);
            }
          } else if (
            source === parent &&
            !path.isAbsolute(request) &&
            !request.startsWith("file:") &&
            !request.startsWith("#") &&
            !isBuiltin(request)
          ) {
            const captured = artifact.captureModule(parent, request, conditions);
            if (captured && "target" in captured) {
              target =
                captured.target.search || captured.target.hash
                  ? captured.target.href
                  : fileURLToPath(captured.target);
            } else if (captured && "retryNative" in captured) {
              try {
                let selected: URL;
                try {
                  selected = moduleResolve(
                    request,
                    pathToFileURL(parent),
                    getBunConditions(requireMode),
                  );
                } catch (error) {
                  if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    error.code !== "ERR_MODULE_NOT_FOUND" ||
                    !("url" in error) ||
                    typeof error.url !== "string"
                  ) {
                    throw error;
                  }
                  selected = new URL(error.url);
                }
                const capturedTarget = artifact.captureResolvedModule(fileURLToPath(selected));
                if (capturedTarget) {
                  const capturedUrl = pathToFileURL(capturedTarget);
                  capturedUrl.search = selected.search;
                  capturedUrl.hash = selected.hash;
                  target =
                    capturedUrl.search || capturedUrl.hash ? capturedUrl.href : capturedTarget;
                }
              } catch {
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
          if (target) {
            artifact.prepareModule(target.startsWith("file:") ? fileURLToPath(target) : target);
          }
          if (original) {
            artifact.prepareNativeScopes(
              target?.startsWith("file:") ? fileURLToPath(target) : (target ?? source),
            );
          }
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
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: params.origin,
    rootDir: params.rootDir,
  });
  (params.bindModuleLoader ?? params.instance.bindModuleLoader.bind(params.instance))(
    (source) =>
      withPluginCache(cache, () => {
        const captured = artifact.resolve(source, rejectHardlinks);
        artifact.prepareModule(captured);
        if (prepareEntryNativeScopes) {
          artifact.prepareNativeScopes(captured);
        }
        return loader(toSafeImportPath(captured));
      }),
    artifact.hasSource,
  );
}
