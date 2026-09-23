import { pathToFileURL } from "node:url";

export function sqliteWorkerPreloadEnv(preloadPath: string): Record<string, string> {
  if (!process.versions.bun) {
    // Keep the runner's resource-context preload: the failure injection must not
    // move the reader onto a different coordinator namespace from its parent.
    return {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${JSON.stringify(preloadPath)}`]
        .filter(Boolean)
        .join(" "),
    };
  }
  const preloadUrl = pathToFileURL(preloadPath).href;
  const selectorUrl = new URL("./bun-sqlite-library.js", import.meta.url).href;
  const loader = Buffer.from(
    `import { ensureSqliteLibrarySelected } from ${JSON.stringify(selectorUrl)};\n` +
      `ensureSqliteLibrarySelected();\n` +
      `await import(${JSON.stringify(preloadUrl)});`,
  ).toString("base64");
  return {
    BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=data:text/javascript;base64,${loader}`]
      .filter(Boolean)
      .join(" "),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
}
