import fs from "node:fs/promises";
import path from "node:path";
import { collectPackageRootModules } from "../../scripts/lib/package-root-modules.mts";

/** The shipped launcher and every package-root module it loads; dist loads the bootstrap. */
export const launcherFixtureModules = collectPackageRootModules([
  "openclaw.mjs",
  "runtime-process-bootstrap.generated.mjs",
]);

/** Stage the shipped launcher modules; each consumer supplies its runtime fixture. */
export async function stageLauncherFixture(root: string): Promise<void> {
  for (const name of launcherFixtureModules) {
    await fs.copyFile(path.resolve(name), path.join(root, name));
  }
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
}
