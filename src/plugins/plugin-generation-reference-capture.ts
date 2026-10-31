import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import type { createPluginCaptureResolver } from "./plugin-capture-resolution.js";
import type { createPluginSourceLinkCapture } from "./plugin-generation-file-capture.js";
import type { createPluginNativeAdmission } from "./plugin-native-admission.js";
import {
  type createPluginDependencyResolver,
  type PluginPackageCapture,
  isPluginPackageFile as inPackage,
  packageName,
} from "./plugin-package-metadata-capture.js";
import { realpathPluginSource } from "./plugin-source-file.js";
import type { createPluginPackageMapReferences } from "./plugin-source-references.js";

/** Resolve one captured source's references without transferring its package or lifetime owners. */
export function createPluginGenerationReferenceCapture({
  source,
  rootDir,
  root,
  boundary,
  destination,
  entry,
  executableEntry,
  execute,
  resolveFrozenInput,
  moduleSource,
  originalSources,
  nativeAdmission,
  resolution,
  references,
  scope,
  packageMap,
  capturedPaths,
  resolveDependency,
  captureFile,
  captureExecutableFile,
  owner,
  sourceLinks,
}: {
  source: string;
  rootDir: string;
  root: string;
  boundary: string;
  destination: string;
  entry?: string;
  executableEntry: boolean;
  execute: boolean;
  resolveFrozenInput?: (filename: string) => string;
  moduleSource?: (filename: string) => string;
  originalSources: ReadonlyMap<string, string>;
  nativeAdmission: Pick<
    ReturnType<typeof createPluginNativeAdmission>,
    "sourceForPrepared" | "resolvePreparedSource"
  >;
  resolution: ReturnType<typeof createPluginCaptureResolver>;
  references: Map<string, Set<string>>;
  scope?: { source: string; manifest: Record<string, unknown>; aliases: ReadonlySet<string> };
  packageMap: ReturnType<typeof createPluginPackageMapReferences>;
  capturedPaths: Map<string, string>;
  resolveDependency: ReturnType<typeof createPluginDependencyResolver>;
  captureFile: (source: string) => void;
  captureExecutableFile: (filename: string) => string | undefined;
  owner: Pick<PluginPackageCapture, "state">;
  sourceLinks: Pick<ReturnType<typeof createPluginSourceLinkCapture>, "contains">;
}) {
  return (
    reference: string,
    kind: "asset" | "import" | "require",
    conditions?: readonly string[],
  ): string | null | undefined => {
    const module = kind !== "asset";
    const importUrl =
      kind === "import" && reference.startsWith(".")
        ? new URL(reference, pathToFileURL(source))
        : undefined;
    let value = importUrl
      ? `./${path.relative(path.dirname(source), fileURLToPath(importUrl))}`
      : module && reference.startsWith("file:")
        ? fileURLToPath(reference)
        : reference;
    if (module && path.isAbsolute(value)) {
      value = resolveFrozenInput?.(value) ?? value;
    }
    const resolve = (specifier: string) => {
      const resolved = resolution.resolve(
        source,
        specifier,
        conditions ?? ["node", "module-sync", kind === "require" ? "require" : "import"],
      );
      if (!resolved?.startsWith("file:")) {
        return resolved;
      }
      // Native resolution may return this generation's compiler output, not a new input.
      const url = new URL(resolved);
      const filename = fileURLToPath(url);
      const captured = moduleSource?.(filename) ?? filename;
      url.pathname = pathToFileURL(
        originalSources.get(captured) ?? nativeAdmission.sourceForPrepared(captured) ?? captured,
      ).pathname;
      return url.href;
    };
    const addDependency = (name: string, importer = source) => {
      const imports = references.get(importer) ?? new Set<string>();
      imports.add(name);
      references.set(importer, imports);
    };
    if (module && !value.startsWith(".") && !path.isAbsolute(value)) {
      if (isBuiltin(value)) {
        return undefined;
      }
      const name = packageName(value);
      const self = scope?.manifest.exports != null && scope.manifest.name === name;
      const resolved =
        value.startsWith("#") || self
          ? packageMap.resolveReference(value, source, conditions ?? ["node", "module-sync", kind])
          : resolve(value);
      const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : resolved;
      if (
        resolution.get(source).options.tsconfigPaths &&
        name !== "openclaw" &&
        name !== "@openclaw/plugin-sdk" &&
        resolved?.startsWith("file:") &&
        input
      ) {
        if (
          inPackage(boundary, input) &&
          (capturedPaths.has(path.resolve(input)) ||
            inPackage(boundary, realpathPluginSource(input)))
        ) {
          captureFile(input);
          return input;
        }
        if (!isPathInside(resolveDependency(name, source)?.root ?? boundary, input)) {
          return conditions && execute ? captureExecutableFile(input) : null;
        }
      }
      if (!value.startsWith("#") && !self) {
        if (conditions && !resolved) {
          return undefined;
        }
        addDependency(name);
        return resolved?.startsWith("file:") ? input : undefined;
      }
      if (!input || isBuiltin(input)) {
        return undefined;
      }
      let external = false;
      if (!self && scope) {
        // Package-map resolution selects the target; string leaves identify lookup aliases only;
        // preserve every matching alias when several names share one physical package.
        for (const alias of scope.aliases) {
          const dependency = resolveDependency(alias, scope.source);
          if (dependency && isPathInside(dependency.root, input)) {
            // Package aliases retain metadata now; execution captures the selected body.
            if (conditions || !execute) {
              addDependency(alias, scope.source);
            }
            external = true;
          }
        }
      }
      if (!external) {
        captureFile(input);
      }
      return input;
    }
    const requested = path.resolve(path.dirname(source), value);
    const lexicalBoundary = entry && !executableEntry ? path.resolve(rootDir) : root;
    const local =
      module && path.isAbsolute(value) && isPathInside(lexicalBoundary, requested)
        ? path.join(boundary, path.relative(lexicalBoundary, requested))
        : requested;
    if (module && !isPathInside(boundary, local)) {
      if (!conditions || !execute) {
        return null;
      }
      const selected = resolve(local);
      if (!selected?.startsWith("file:")) {
        return undefined;
      }
      return captureExecutableFile(fileURLToPath(selected));
    }
    if (
      !value ||
      (!module && path.isAbsolute(value)) ||
      !isPathInside(boundary, local) ||
      local === boundary
    ) {
      return undefined;
    }
    // Dependency files retain their package owner, rather than becoming public source inputs.
    if (
      module &&
      path.isAbsolute(value) &&
      path.relative(boundary, local).split(path.sep).includes("node_modules")
    ) {
      return undefined;
    }
    // Captured local peers survive edits; deferred links enter only on executable demand.
    const fromCopy = owner.state === "body" && !sourceLinks.contains(local);
    const moduleRequest =
      nativeAdmission.resolvePreparedSource(local)?.path ??
      (fromCopy ? path.join(destination, path.relative(root, local)) : local);
    const resolved = module ? resolve(moduleRequest) : undefined;
    if (module && !resolved) {
      return undefined;
    }
    const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : (resolved ?? local);
    const capturedInput = capturedPaths.has(path.resolve(input));
    const preparedInput = nativeAdmission.resolvePreparedSource(input);
    if (capturedInput || fs.existsSync(preparedInput?.path ?? input)) {
      if (
        module &&
        execute &&
        !capturedInput &&
        !preparedInput &&
        !isPathInside(boundary, realpathPluginSource(input))
      ) {
        return conditions ? captureExecutableFile(input) : null;
      }
      captureFile(input);
      if (module && path.isAbsolute(value)) {
        capturedPaths.set(requested, capturedPaths.get(path.resolve(input))!);
      }
      return input;
    }
    return undefined;
  };
}
