import fs from "node:fs";
import { normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";

/** The process-wide capture owner installs this observer once. */
export function observePluginNativeLoads(): ReadonlySet<string> {
  const paths = new Set<string>();
  const loadAddon = process.dlopen.bind(process);
  // Node keeps main-thread addons loaded: https://github.com/nodejs/node/blob/v24.8.0/src/env.cc#L1050
  // Windows mapped-image unlink fails (access denied becomes EPERM):
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c#L1172
  // https://github.com/libuv/libuv/blob/v1.51.0/src/win/error.c#L158
  // Record before initialization: it can throw or reenter cleanup with the image already mapped.
  // Full diagnostic reports race Windows DbgHelp across workers; cleanup consumes load facts only.
  process.dlopen = (...args) => {
    try {
      const file = fs.realpathSync.native(args[1]);
      paths.add(process.platform === "win32" ? normalizeWindowsPathPreservingCase(file) : file);
    } catch {
      // Observation must not replace the native loader's return or original error.
    }
    return loadAddon(...args);
  };
  return paths;
}
