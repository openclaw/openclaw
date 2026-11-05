import path from "node:path";
import type { Plugin } from "vitest/config";

/** Shared by CI routing and native Vitest dependency recording. */
export const vitestDeclaredInputs = [
  ["src/hooks/install.test.ts", "test/fixtures/hooks-install/tar-evil-id.tar"],
  ["src/config/defaults.ollama-output-cap.test.ts", "extensions/ollama/openclaw.plugin.json"],
] as const;

/** File reads that cannot be expressed as module imports belong to their test. */
export function createVitestDeclaredInputsPlugin(root: string): Plugin {
  const inputs = new Map(
    vitestDeclaredInputs.map(
      ([file, input]) => [path.resolve(root, file), path.resolve(root, input)] as const,
    ),
  );
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
