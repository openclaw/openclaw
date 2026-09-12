import { pathToFileURL } from "node:url";

export function sqliteWorkerPreloadEnv(preloadPath: string): Record<string, string> {
  if (!process.versions.bun) {
    return { NODE_OPTIONS: `--require=${JSON.stringify(preloadPath)}` };
  }
  const preloadUrl = pathToFileURL(preloadPath).href;
  const loader = Buffer.from(`import ${JSON.stringify(preloadUrl)};`).toString("base64");
  return { BUN_OPTIONS: `--preload=data:text/javascript;base64,${loader}` };
}
