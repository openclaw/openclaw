import path from "node:path";
import type { Plugin } from "vitest/config";

/** File reads that cannot be expressed as module imports belong to their test. */
export function createVitestDeclaredInputsPlugin(root: string): Plugin {
  const inputs = new Map([
    [
      path.resolve(root, "src/hooks/install.test.ts"),
      path.resolve(root, "test/fixtures/hooks-install/tar-evil-id.tar"),
    ],
  ]);
  return {
    name: "openclaw:declared-test-inputs",
    enforce: "pre",
    transform(_source, id) {
      const input = inputs.get(path.resolve(id.split("?")[0]!));
      if (input) {
        this.addWatchFile(input);
      }
      return null;
    },
  };
}
