import nodeModule from "node:module";

export function registerUpdateFixtureModuleOverrides(
  overrides: ReadonlyMap<string, string>,
  completeOverrides?: ReadonlySet<string>,
) {
  return nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const replacement = overrides.get(url);
      return replacement === undefined
        ? nextLoad(url, context)
        : {
            format: "module",
            source: completeOverrides?.has(url)
              ? replacement
              : `export * from ${JSON.stringify(url + "?fixture-original")};\n${replacement}`,
            shortCircuit: true,
          };
    },
  });
}
