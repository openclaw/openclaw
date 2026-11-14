import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { throwExpectedCliError } from "./expected-cli-error.js";

/** Private fresh-fixture bootstrap; every other QA command remains source-only. */
export function registerQaInitializeCli(program: Command): void {
  program
    .command("qa")
    .command("initialize")
    .action(async () => {
      const tempRoot = process.env.OPENCLAW_QA_TEMP_ROOT;
      if (!tempRoot) {
        throw new Error("QA initialization requires OPENCLAW_QA_TEMP_ROOT");
      }
      const packageRoot = resolveOpenClawPackageRootSync({
        argv1: process.argv[1],
        cwd: process.cwd(),
        moduleUrl: import.meta.url,
      });
      if (!packageRoot) {
        throw new Error("Cannot resolve the private QA package root");
      }
      // Keep private QA out of the ordinary release bundle graph.
      const runtimeUrl = pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/qa-runtime.js"));
      const { initializeQaRuntimeState, closeQaRuntimeStores }: Record<string, unknown> =
        await import(runtimeUrl.href);
      if (
        typeof initializeQaRuntimeState !== "function" ||
        typeof closeQaRuntimeStores !== "function"
      ) {
        throw new Error("Private QA runtime is not available in this package");
      }
      try {
        await initializeQaRuntimeState();
      } catch (error) {
        throwExpectedCliError(
          `QA initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await closeQaRuntimeStores(tempRoot);
      }
    });
}
