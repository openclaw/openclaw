import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PackageMapContext = {
  packageDir: string;
  request: string;
  conditions: ReadonlySet<string>;
  internal: boolean;
  runtime: "node" | "bun";
  resolvePackage: (request: string) => URL;
};

function invalid(code: string, context: PackageMapContext, detail: string) {
  return Object.assign(
    new Error(`${detail} in ${path.join(context.packageDir, "package.json")}: ${context.request}`),
    { code },
  );
}

function invalidTarget(context: PackageMapContext, target: unknown) {
  return invalid(
    "ERR_INVALID_PACKAGE_TARGET",
    context,
    `Invalid package target ${JSON.stringify(target)}`,
  );
}

const invalidSegment =
  /(^|[\\/])((?:\.|%2e){1,2}|(?:n|%6e)(?:o|%6f)(?:d|%64)(?:e|%65)(?:_|%5f)(?:m|%6d)(?:o|%6f)(?:d|%64)(?:u|%75)(?:l|%6c)(?:e|%65)(?:s|%73))([\\/]|$)/i;

function numericIndex(key: string) {
  const value = Number(key);
  return `${value}` === key && value >= 0 && value < 0xffff_ffff;
}

function patternRank(left: string, right: string) {
  const a = left.indexOf("*");
  const b = right.indexOf("*");
  const aLength = a < 0 ? left.length : a + 1;
  const bLength = b < 0 ? right.length : b + 1;
  if (aLength !== bLength) {
    return bLength - aLength;
  }
  if (a < 0) {
    return 1;
  }
  if (b < 0) {
    return -1;
  }
  return right.length - left.length;
}

function selectTarget(
  target: unknown,
  context: PackageMapContext,
  pattern = false,
  subpath = "",
): URL | null | undefined {
  if (typeof target === "string") {
    if (!target.startsWith("./")) {
      if (
        context.internal &&
        !target.startsWith("/") &&
        !target.startsWith("../") &&
        !URL.canParse(target)
      ) {
        return context.resolvePackage(pattern ? target.replaceAll("*", subpath) : target + subpath);
      }
      throw invalidTarget(context, target);
    }
    if (invalidSegment.test(target.slice(2))) {
      throw invalidTarget(context, target);
    }
    const packageURL = pathToFileURL(path.join(context.packageDir, "package.json"));
    const selected = new URL(target, packageURL);
    if (!selected.pathname.startsWith(new URL(".", packageURL).pathname)) {
      throw invalidTarget(context, target);
    }
    if (!pattern) {
      return selected;
    }
    if (invalidSegment.test(subpath)) {
      throw invalid(
        context.runtime === "bun" ? "ERR_MODULE_NOT_FOUND" : "ERR_INVALID_MODULE_SPECIFIER",
        context,
        "Invalid package subpath",
      );
    }
    return new URL(selected.href.replaceAll("*", subpath));
  }
  if (Array.isArray(target)) {
    if (target.length === 0) {
      return null;
    }
    let last: Error | null | undefined;
    for (const item of target) {
      let selected;
      try {
        selected = selectTarget(item, context, pattern, subpath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ERR_INVALID_PACKAGE_TARGET"
        ) {
          throw error;
        }
        last = error;
        continue;
      }
      // Null permits an array fallback, but stops an enclosing condition object.
      if (selected === undefined) {
        continue;
      }
      if (selected === null) {
        last = null;
        continue;
      }
      return selected;
    }
    if (last == null) {
      return last;
    }
    throw last;
  }
  if (target && typeof target === "object") {
    const keys = Object.getOwnPropertyNames(target);
    if (keys.some(numericIndex)) {
      throw invalid(
        "ERR_INVALID_PACKAGE_CONFIG",
        context,
        "Package map contains numeric condition keys",
      );
    }
    for (const key of keys) {
      if (key === "default" || context.conditions.has(key)) {
        const selected = selectTarget(Reflect.get(target, key), context, pattern, subpath);
        if (selected !== undefined) {
          return selected;
        }
      }
    }
    return undefined;
  }
  if (target === null) {
    return null;
  }
  throw invalidTarget(context, target);
}

/** Select once from authenticated metadata; missing target files never select another array arm. */
export function selectPluginSnapshotPackageMap(map: unknown, context: PackageMapContext): URL {
  const notFound = () =>
    invalid(
      context.internal ? "ERR_PACKAGE_IMPORT_NOT_DEFINED" : "ERR_PACKAGE_PATH_NOT_EXPORTED",
      context,
      "No package mapping",
    );
  if (
    context.internal &&
    (context.request === "#" || (context.runtime === "node" && context.request.endsWith("/")))
  ) {
    throw invalid(
      context.runtime === "bun" ? "ERR_MODULE_NOT_FOUND" : "ERR_INVALID_MODULE_SPECIFIER",
      context,
      "Invalid package import",
    );
  }
  let mappings = map;
  if (!context.internal) {
    let sugar = typeof map === "string" || Array.isArray(map);
    if (map && typeof map === "object" && !Array.isArray(map)) {
      const shapes = new Set(Object.keys(map).map((key) => key === "" || !key.startsWith(".")));
      if (shapes.size > 1) {
        throw invalid(
          "ERR_INVALID_PACKAGE_CONFIG",
          context,
          "Package exports mixes subpath and condition keys",
        );
      }
      sugar = shapes.has(true);
    }
    if (sugar) {
      mappings = { ".": map };
    }
  }
  if (!mappings || typeof mappings !== "object") {
    throw notFound();
  }
  let match: string | undefined;
  let subpath = "";
  let pattern = false;
  if (
    Object.hasOwn(mappings, context.request) &&
    !context.request.includes("*") &&
    (context.internal || !context.request.endsWith("/"))
  ) {
    match = context.request;
  } else {
    for (const key of Object.keys(mappings)) {
      const star = key.indexOf("*");
      if (star < 0 || star !== key.lastIndexOf("*")) {
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (
        context.request.length >= key.length - (context.runtime === "bun" ? 1 : 0) &&
        context.request.startsWith(prefix) &&
        context.request.endsWith(suffix) &&
        (!match || patternRank(match, key) > 0)
      ) {
        match = key;
        subpath = context.request.slice(star, context.request.length - suffix.length);
        pattern = true;
      }
    }
  }
  if (match === undefined) {
    throw notFound();
  }
  const selected = selectTarget(Reflect.get(mappings, match), context, pattern, subpath);
  if (selected == null) {
    throw notFound();
  }
  if (selected.protocol === "file:" && /%2f|%5c/i.test(selected.pathname)) {
    throw invalid(
      context.runtime === "bun" ? "ERR_MODULE_NOT_FOUND" : "ERR_INVALID_MODULE_SPECIFIER",
      context,
      "Invalid encoded separator",
    );
  }
  return selected;
}

/** Match the TypeScript configuration lookup used by Jiti without consulting the live tree. */
export function resolvePluginSnapshotConfigPath(
  importer: string,
  request: string,
  source: {
    file: (filename: string) => string | undefined;
    directory: (filename: string) => boolean;
    packageAt: (directory: string) => { exports?: unknown; tsconfig?: string } | undefined;
    runtime: "node" | "bun";
  },
): string | undefined {
  const configFile = (filename: string) =>
    source.file(filename) ??
    (!filename.endsWith(".json") ? source.file(`${filename}.json`) : undefined);
  if (request.startsWith(".") || path.isAbsolute(request)) {
    return configFile(
      path.resolve(path.dirname(importer), request === ".." ? "../tsconfig.json" : request),
    );
  }
  const parts = request.split("/");
  const packageName = parts.splice(0, request.startsWith("@") ? 2 : 1).join("/");
  if (!packageName || request.includes("\\") || request.includes("%")) {
    return undefined;
  }
  let directory = path.dirname(importer);
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    if (source.directory(candidate)) {
      const subpath = parts.join("/");
      const metadata = source.packageAt(candidate);
      if (metadata?.exports != null) {
        const selected = selectPluginSnapshotPackageMap(metadata.exports, {
          packageDir: candidate,
          request: subpath ? `./${subpath}` : ".",
          conditions: new Set(["require", "types"]),
          internal: false,
          runtime: source.runtime,
          resolvePackage: () => {
            throw new Error("Invalid configuration export");
          },
        });
        return selected.protocol === "file:" ? source.file(fileURLToPath(selected)) : undefined;
      }
      const configured = source.file(
        path.join(candidate, subpath || metadata?.tsconfig || "tsconfig.json"),
      );
      if (configured) {
        return configured;
      }
      const target = path.join(candidate, subpath);
      const suffixed = !target.endsWith(".json") ? source.file(`${target}.json`) : undefined;
      if (suffixed) {
        return suffixed;
      }
      if (source.directory(target)) {
        return source.file(
          path.join(target, source.packageAt(target)?.tsconfig || "tsconfig.json"),
        );
      }
      return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
