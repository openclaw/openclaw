import { pathToFileURL } from "node:url";

/** Descendants can select either runtime, independently of the test runner. */
export function withRuntimePreload(env: NodeJS.ProcessEnv, preloadPath: string): NodeJS.ProcessEnv {
  const preloadUrl = pathToFileURL(preloadPath).href;
  return {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${preloadUrl}`.trim(),
    BUN_OPTIONS: `${env.BUN_OPTIONS ?? ""} --preload=${preloadUrl}`.trim(),
  };
}
