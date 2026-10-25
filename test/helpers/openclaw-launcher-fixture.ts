import fs from "node:fs/promises";
import path from "node:path";

/** Stage the shipped launcher modules; each consumer supplies its runtime fixture. */
export async function stageLauncherFixture(root: string): Promise<void> {
  for (const name of [
    "openclaw.mjs",
    "cli-invocation.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "node-version.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "cli-parent-lifetime.mjs",
    "node-runtime-env.mjs",
    "cli-root-options.mjs",
    "gateway-run-argv.mjs",
    "gateway-shutdown-budget.mjs",
    "node-sqlite.mjs",
  ]) {
    await fs.copyFile(path.resolve(name), path.join(root, name));
  }
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
}
