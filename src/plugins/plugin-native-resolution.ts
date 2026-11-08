export function getPluginBunConditions(requireMode: boolean): Set<string> {
  const conditions = new Set(["bun", "node", "module-sync", requireMode ? "require" : "import"]);
  if (!process.execArgv.includes("--no-addons")) {
    conditions.add("node-addons");
  }
  for (const condition of getPluginConfiguredConditions()) {
    conditions.add(condition);
  }
  return conditions;
}

/** Keep explicit conditions distinct from runtime defaults when binding persisted source. */
export function getPluginConfiguredConditions(): Set<string> {
  const conditions = new Set<string>();
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    if (argument === "--conditions" || argument === "-C") {
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
