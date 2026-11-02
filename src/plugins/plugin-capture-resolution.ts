import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JitiOptions } from "jiti";
import { createJiti } from "./jiti-factory.js";

const javascriptExtension = /\.(c|m)?j(sx?)$/;
const nativeJitiModule = /node_modules\/(?:typescript|jiti)\//;

function typescriptSibling(source: string, specifier: string, options: JitiOptions) {
  if (
    !path.isAbsolute(specifier) ||
    !javascriptExtension.test(specifier) ||
    options.tsconfigPaths ||
    Object.keys(options.alias ?? {}).length ||
    options.nativeModules?.length ||
    nativeJitiModule.test(specifier.replaceAll("\\", "/")) ||
    fs.existsSync(specifier)
  ) {
    return undefined;
  }
  try {
    const candidate = specifier.replace(javascriptExtension, ".$1t$2");
    const extensions = options.extensions ?? [];
    const firstAdditional = extensions.find((extension) => extension !== ".js");
    if (!firstAdditional || !fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return undefined;
    }
    const require = createRequire(source);
    const nativeExtensions = Object.keys(require.extensions);
    // Jiti tries appended extensions and native resolution before its TypeScript sibling.
    // An existing directory also needs Jiti's package-main and index selection.
    if (
      [
        ...extensions,
        ...nativeExtensions,
        ...nativeExtensions.map((ext) => firstAdditional + ext),
      ].some((extension) => fs.existsSync(specifier + extension))
    ) {
      return undefined;
    }
    return require.resolve(candidate);
  } catch {
    // Failed probes and native hooks still follow Jiti's try-resolution contract.
    return undefined;
  }
}

/** Resolution state belongs to one capture, never to evaluated plugin modules. */
export function createPluginCaptureResolver(options?: JitiOptions) {
  let shared: ReturnType<typeof createJiti> | undefined;
  const scoped = new Map<string, ReturnType<typeof createJiti>>();
  const get = (source: string, parentSensitive = false) => {
    if (!shared) {
      shared = createJiti(source, {
        ...options,
        fsCache: false,
        moduleCache: false,
        tryNative: false,
      });
      scoped.set(shared.options.tsconfigPaths ? source : path.dirname(source), shared);
    }
    if (!shared.options.tsconfigPaths && !parentSensitive) {
      return shared;
    }
    // First demand still selects each source's tsconfig; bare fallback uses its package scope.
    const key = shared.options.tsconfigPaths ? source : path.dirname(source);
    let resolver = scoped.get(key);
    if (!resolver) {
      resolver = createJiti(source, shared.options);
      scoped.set(key, resolver);
    }
    return resolver;
  };
  return {
    get,
    clear() {
      shared = undefined;
      scoped.clear();
    },
    resolve(source: string, reference: string, conditions: readonly string[]) {
      const resolverOptions = get(source).options;
      const configured = Boolean(
        resolverOptions.tsconfigPaths ||
        Object.keys(resolverOptions.alias ?? {}).length ||
        resolverOptions.nativeModules?.length ||
        nativeJitiModule.test(source.replaceAll("\\", "/")),
      );
      const specifier =
        !configured && reference.startsWith(".") && !/[?#]/.test(reference)
          ? path.resolve(path.dirname(source), reference)
          : reference;
      const resolver = get(source, configured || !path.isAbsolute(specifier));
      return resolver.esmResolve(
        typescriptSibling(source, specifier, resolver.options) ?? specifier,
        { try: true, parentURL: pathToFileURL(source), conditions: [...conditions] },
      );
    },
  };
}
