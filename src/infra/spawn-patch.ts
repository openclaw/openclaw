/**
 * Global patch for child_process.spawn to prevent fd leaks
 *
 * This patches all spawn() calls (including third-party dependencies)
 * to automatically set closeOnExec: true, preventing file descriptor
 * leaks when spawning Python or other processes that import large libraries.
 */

import type { SpawnOptions } from "node:child_process";
import { spawn as originalSpawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let patched = false;

export function patchSpawnGlobally(): void {
  if (patched) {
    return;
  }
  patched = true;

  const cp = require("node:child_process");

  cp.spawn = function patchedSpawn(
    command: string,
    args?: readonly string[] | SpawnOptions,
    options?: SpawnOptions,
  ) {
    // Handle overloaded signatures
    let actualArgs: readonly string[] | undefined;
    let actualOptions: SpawnOptions | undefined;

    if (Array.isArray(args)) {
      actualArgs = args;
      actualOptions = options;
    } else {
      actualOptions = args as SpawnOptions | undefined;
    }

    // Inject closeOnExec: true if not explicitly set
    const enhancedOptions = {
      ...actualOptions,
      closeOnExec: (actualOptions as any)?.closeOnExec ?? true,
    };

    // Call original spawn with enhanced options
    if (actualArgs) {
      return originalSpawn(command, actualArgs, enhancedOptions);
    }
    return originalSpawn(command, enhancedOptions);
  };

  console.log("[spawn-patch] Global spawn() patched with closeOnExec: true");
}
