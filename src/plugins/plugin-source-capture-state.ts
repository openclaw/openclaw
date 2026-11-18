import fs from "node:fs";
import path from "node:path";
import { clearPluginSourceCaptureModuleCache } from "./native-module-require.js";

/** Local acquisition state shares one directory owner's physical custody and cleanup. */
export function createPluginSourceCaptureState(owner: {
  directory: string;
  outputRoot?: string;
  assertAvailable?(): void;
  dispose(): void;
  disposeAsync(): Promise<void>;
}) {
  const { directory } = owner;
  const additions = new Set<string>();
  const captureFailures = new Map<string, unknown>();
  let disposed = false;
  const acquire = <T>(capture: () => T) => {
    owner.assertAvailable?.();
    if (disposed) {
      throw new Error("Plugin module capture has been disposed");
    }
    try {
      const value = capture();
      return { value, additions: [...additions] };
    } catch (error) {
      // Another specifier must not admit files from an incomplete capture transaction.
      for (const filename of additions) {
        captureFailures.set(filename, error);
      }
      throw error;
    } finally {
      additions.clear();
    }
  };
  const assertModuleAvailable = (filename: string) => {
    owner.assertAvailable?.();
    if (captureFailures.has(filename)) {
      throw captureFailures.get(filename);
    }
  };
  const beginDisposal = () => {
    disposed = true;
    // Revoke cached modules before removal yields, including compiled CJS helpers.
    clearPluginSourceCaptureModuleCache(directory);
    captureFailures.clear();
  };
  return {
    additions,
    capture: acquire,
    assertModuleAvailable,
    directory,
    outputRoot: owner.outputRoot,
    linkHost: (hostRoot: string) => {
      const modules = path.join(directory, "node_modules");
      fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
      // Native ESM follows the selected host's real public exports and identity.
      fs.symlinkSync(hostRoot, path.join(modules, "openclaw"), "junction");
    },
    dispose: () => {
      beginDisposal();
      owner.dispose();
    },
    disposeAsync: async () => {
      beginDisposal();
      await owner.disposeAsync();
    },
  };
}
