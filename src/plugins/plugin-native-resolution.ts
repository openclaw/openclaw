import { parseNodeOptionsEnvVar } from "../../node-runtime-env.mjs";

/** NODE_OPTIONS precedes CLI flags; Bun treats any --no-addons as disabling addons. */
export function getPluginResolutionPolicy(env: NodeJS.ProcessEnv = process.env) {
  const args = [...(parseNodeOptionsEnvVar(env.NODE_OPTIONS) ?? []), ...process.execArgv];
  const bun = Boolean(process.versions.bun);
  const conditions = new Set<string>();
  let addons = true;
  let requireModule = true;
  let preserveSymlinks = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--conditions" || argument === "-C") {
      const condition = args[index + 1];
      if (condition && !condition.startsWith("-")) {
        conditions.add(condition);
        index += 1;
      }
    } else if (argument?.startsWith("--conditions=")) {
      conditions.add(argument.slice("--conditions=".length));
    } else if (argument === "--no-addons") {
      addons = false;
    } else if (argument === "--addons" && !bun) {
      addons = true;
    } else if (argument === "--no-experimental-require-module" && !bun) {
      requireModule = false;
    } else if (argument === "--experimental-require-module" && !bun) {
      requireModule = true;
    } else if (argument === "--preserve-symlinks") {
      preserveSymlinks = true;
    } else if (argument === "--no-preserve-symlinks") {
      preserveSymlinks = false;
    }
  }
  return { conditions, addons, requireModule, preserveSymlinks };
}

export function getPluginRuntimeConditions(requireMode: boolean): Set<string> {
  const policy = getPluginResolutionPolicy();
  return new Set([
    "node",
    ...(process.versions.bun ? ["bun"] : []),
    requireMode ? "require" : "import",
    ...(policy.requireModule ? ["module-sync"] : []),
    ...(policy.addons ? ["node-addons"] : []),
    ...policy.conditions,
  ]);
}

export function createPluginNativeImportPattern(imports: unknown) {
  const importKeys = imports && typeof imports === "object" ? Object.keys(imports) : [];
  // import-meta-resolve cannot match wildcard trailers; Bun must select those requests.
  return (specifier: string) =>
    !importKeys.includes(specifier) &&
    importKeys.some((key) => {
      const star = key.indexOf("*");
      return (
        star >= 0 &&
        star < key.length - 1 &&
        key.lastIndexOf("*") === star &&
        specifier.startsWith(key.slice(0, star)) &&
        specifier.endsWith(key.slice(star + 1))
      );
    });
}
