import { randomUUID } from "node:crypto";
import fs from "node:fs";
import NativeModule, { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { getPluginBunConditions } from "./plugin-native-resolution.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { resolvePluginPackageMapTarget } from "./plugin-source-references.js";

const bindingKey = "openclaw.pluginSnapshotModuleFacades";
const bindings = resolveGlobalMap<
  string,
  {
    selectRequire(require: NodeJS.Require, request: string, options?: { paths?: string[] }): string;
    importSpecifier(request: unknown): string;
    resolveSpecifier(request: unknown, importer: string | URL): string;
  }
>(Symbol.for(bindingKey));
type ModuleFacade = { filename: string; helpers: string; dispose(): void };
const facades = new WeakMap<PluginGenerationArtifact, ModuleFacade>();

/** Bind createRequire to source custody even when a plugin supplies a different anchor. */
export function pluginSnapshotModuleFacade(
  artifact: PluginGenerationArtifact,
  sdkRoots: readonly string[],
  resolveHost: (specifier: string) => string | undefined,
): ModuleFacade | undefined {
  if (!artifact.frozenSource) {
    return undefined;
  }
  const existing = facades.get(artifact);
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  const directory = fs.mkdtempSync(path.join(path.dirname(artifact.rootDir), ".module-"));
  const filename = path.join(directory, "module.cjs");
  const helpers = path.join(directory, "helpers.mjs");
  bindings.set(id, {
    selectRequire(require, request, options) {
      if (request === "module" || request === "node:module") {
        return filename;
      }
      if (isBuiltin(request)) {
        return request;
      }
      const selected = artifact.hasSource(request)
        ? artifact.resolve(request)
        : require.resolve(request, options);
      if (sdkRoots.some((root) => isPathInside(root, selected))) {
        return selected;
      }
      artifact.assertFrozenModule?.(selected);
      const captured = artifact.captureResolvedModule(selected);
      if (!captured) {
        throw new PluginSnapshotDependencyError(selected);
      }
      artifact.prepareModule(captured);
      artifact.prepareNativeScopes(captured);
      return captured;
    },
    importSpecifier(request) {
      if (typeof request === "symbol") {
        throw new TypeError("Cannot convert a Symbol value to a string");
      }
      const specifier = String(request);
      if (specifier === "module" || specifier === "node:module") {
        return filename;
      }
      if (
        /^[a-z][a-z\d+.-]*:/iu.test(specifier) &&
        !path.isAbsolute(specifier) &&
        !specifier.startsWith("file:") &&
        !isBuiltin(specifier)
      ) {
        throw new PluginSnapshotDependencyError(specifier);
      }
      return specifier;
    },
    resolveSpecifier(request, importer) {
      const specifier = this.importSpecifier(request);
      if (isBuiltin(specifier)) {
        return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
      }
      if (specifier === filename) {
        return pathToFileURL(filename).href;
      }
      const host = resolveHost(specifier);
      if (host) {
        return pathToFileURL(host).href;
      }
      const requestedPath = specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier;
      if (
        path.isAbsolute(requestedPath) &&
        sdkRoots.some((root) => isPathInside(root, requestedPath))
      ) {
        return specifier.startsWith("file:") ? specifier : pathToFileURL(specifier).href;
      }
      const parent =
        typeof importer === "string" && !importer.startsWith("file:")
          ? importer
          : fileURLToPath(importer);
      const capturedParent = artifact.hasSource(parent) ? artifact.resolve(parent) : parent;
      artifact.assertFrozenModule?.(capturedParent);
      artifact.prepareModule(capturedParent);
      const conditions = [...getPluginBunConditions(false)];
      const captured = artifact.captureModule(capturedParent, specifier, conditions);
      if (captured && "target" in captured) {
        return captured.target.href;
      }
      const selected = resolvePluginPackageMapTarget(specifier, capturedParent, conditions);
      if (!selected) {
        throw new PluginSnapshotDependencyError(specifier);
      }
      const target = fileURLToPath(selected);
      if (sdkRoots.some((root) => isPathInside(root, target))) {
        return selected.href;
      }
      artifact.assertFrozenModule?.(target);
      const resolved = artifact.captureResolvedModule(target);
      if (!resolved) {
        throw new PluginSnapshotDependencyError(target);
      }
      selected.pathname = pathToFileURL(resolved).pathname;
      return selected.href;
    },
  });
  const lookup = `const getBinding = () => {
  const binding = globalThis[Symbol.for(${JSON.stringify(bindingKey)})].get(${JSON.stringify(id)});
  if (!binding) throw new Error("Plugin source view has been disposed");
  return binding;
};`;
  try {
    fs.writeFileSync(
      filename,
      `const NativeModule = require("node:module");
${lookup}
const createRequire = anchor => {
  getBinding();
  const native = NativeModule.createRequire(anchor);
  const select = (request, options) => getBinding().selectRequire(native, request, options);
  const require = request => native(select(request));
  return Object.assign(require, native, { resolve: Object.assign(select, native.resolve) });
};
const Module = new Proxy(NativeModule, {
  get(target, key, receiver) {
    if (key === "createRequire") return createRequire;
    if (key === "Module") return Module;
    return Reflect.get(target, key, receiver);
  }
});
// Static names preserve native ESM named imports while CommonJS receives the callable Module.
${Object.keys(NativeModule)
  .filter((key) => /^[a-z_$][\w$]*$/iu.test(key))
  .map((key) => `exports.${key} = Module.${key};`)
  .join("\n")}
module.exports = Module;
`,
      { mode: 0o600, flag: "wx" },
    );
    fs.writeFileSync(
      helpers,
      `export { createRequire } from "./module.cjs";
${lookup}
export const importSpecifier = request => getBinding().importSpecifier(request);
export const resolveSpecifier = (request, importer) => getBinding().resolveSpecifier(request, importer);
`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    bindings.delete(id);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const facade: ModuleFacade = {
    filename,
    helpers,
    dispose() {
      bindings.delete(id);
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
  facades.set(artifact, facade);
  return facade;
}

export function disposePluginSnapshotModuleFacade(artifact: PluginGenerationArtifact): void {
  facades.get(artifact)?.dispose();
  facades.delete(artifact);
}
