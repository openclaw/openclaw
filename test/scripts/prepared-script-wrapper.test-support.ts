import { Buffer } from "node:buffer";

/** Keep real wrappers and source main guards while borrowing the prepared module graph. */
export function preparedScriptWrapperPreload(
  entries: ReadonlyArray<readonly [source: URL, prepared: URL]>,
  virtualModules: ReadonlyArray<readonly [source: URL, prepared: URL]> = [],
): string {
  const modules = Object.fromEntries(
    [...entries, ...virtualModules]
      .filter(([source, prepared]) => source.href !== prepared.href)
      .map(([source, prepared]) => [source.href, prepared.href]),
  );
  if (Object.keys(modules).length === 0) {
    return "";
  }
  const virtualSources = virtualModules
    .filter(([source, prepared]) => source.href !== prepared.href)
    .map(([source]) => source.href);
  // Literal createRequire paths retain source extensions in otherwise compiled modules.
  const resolveVirtual = virtualSources.length
    ? `    const requested = specifier.startsWith(".") && context.parentURL
      ? new URL(specifier, context.parentURL).href : specifier;
    if (${JSON.stringify(virtualSources)}.includes(requested)) {
      return { url: requested, shortCircuit: true };
    }
`
    : "";
  return `import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
const modules = ${JSON.stringify(modules)};
const sources = new Map(Object.entries(modules).map(([source, prepared]) => [prepared, source]));
registerHooks({
  resolve(specifier, context, nextResolve) {
${resolveVirtual}    const prepared = modules[context.parentURL];
    const resolved = nextResolve(specifier, prepared && specifier.startsWith(".")
      ? { ...context, parentURL: prepared } : context);
    const source = sources.get(resolved.url);
    return source ? { ...resolved, url: source } : resolved;
  },
  load(url, context, nextLoad) {
    const prepared = modules[url];
    return prepared ? { format: "module", source: readFileSync(new URL(prepared), "utf8"), shortCircuit: true }
      : nextLoad(url, context);
  },
});`;
}

export function preparedScriptWrapperEnv(
  entries: ReadonlyArray<readonly [source: URL, prepared: URL]>,
  env: NodeJS.ProcessEnv = process.env,
  virtualModules: ReadonlyArray<readonly [source: URL, prepared: URL]> = [],
): NodeJS.ProcessEnv {
  const preload = preparedScriptWrapperPreload(entries, virtualModules);
  if (!preload) {
    return { ...env };
  }
  const url = `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`;
  return { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${url}`].filter(Boolean).join(" ") };
}
