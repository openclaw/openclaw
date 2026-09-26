import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";

export function updateRecoveryStartupLocation(installRoot: string) {
  const parent = path.dirname(installRoot);
  const retained =
    path.basename(installRoot) === "previous" &&
    /^\.openclaw\.package-activation-[a-f0-9]{24}$/u.test(path.basename(parent));
  const anchor = retained ? parent : resolvePackageActivationAnchor(installRoot);
  return {
    anchor,
    retained,
    present: [
      anchor,
      resolvePackageActivationControl(anchor),
      resolvePackageActivationJournalPath(anchor),
    ].some((file) => Boolean(fs.lstatSync(file, { throwIfNoEntry: false }))),
  };
}

/** Fixed core layout only: do not consult cwd, argv, plugins or a global cache at
 * the SQLite bootstrap boundary. Standalone recovery assets have no package. */
export function resolveUpdateRecoveryRuntimeRoot(moduleUrl: string): string | undefined {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (let depth = 0; depth < 8; depth += 1) {
    if (["src", "dist"].includes(path.basename(directory))) {
      const root = path.dirname(directory);
      const manifest = path.join(root, "package.json");
      const exists = fs.lstatSync(manifest, { throwIfNoEntry: false });
      if (!exists || JSON.parse(fs.readFileSync(manifest, "utf8")).name !== "openclaw") {
        // Independently emitted helpers have a module-format manifest, not an
        // OpenClaw package identity. Activation evidence still fails closed if
        // a pending or retained package's manifest was removed or changed.
        const location = updateRecoveryStartupLocation(root);
        if (location.present || location.retained) {
          throw new Error("Startup writer package identity changed.");
        }
        return undefined;
      }
      return root;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
  return undefined;
}
