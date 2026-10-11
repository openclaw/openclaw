import { pathToFileURL } from "node:url";
import { afterEach, vi } from "vitest";
import * as runtimeWorkerUrl from "./runtime-worker-url.js";

const resolveWorkerExecArgv = runtimeWorkerUrl.resolveRuntimeWorkerThreadExecArgv;
let restoreWorkerExecArgv: (() => void) | undefined;

afterEach(() => {
  restoreWorkerExecArgv?.();
  restoreWorkerExecArgv = undefined;
});

/** Builds preload env and installs explicit Bun Worker preload forwarding for the test. */
export function sqliteWorkerPreloadEnv(preloadPath: string): Record<string, string> {
  if (!process.versions.bun) {
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
  const preload = `data:text/javascript;base64,${loader}`;
  // Bun does not apply env.BUN_OPTIONS to Workers with an explicit environment.
  const workerExecArgv = vi
    .spyOn(runtimeWorkerUrl, "resolveRuntimeWorkerThreadExecArgv")
    .mockImplementation((...args) => {
      const execArgv = resolveWorkerExecArgv(...args);
      const workerPreload = process.env.OPENCLAW_TEST_SQLITE_WORKER_PRELOAD;
      return workerPreload ? [...execArgv, "--preload", workerPreload] : execArgv;
    });
  restoreWorkerExecArgv = () => workerExecArgv.mockRestore();
  return {
    BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    OPENCLAW_TEST_SQLITE_WORKER_PRELOAD: preload,
  };
}
