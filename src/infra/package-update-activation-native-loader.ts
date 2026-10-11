import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

let packageRoots: readonly string[] = [];

/** Bind FreeBSD process identity to the package trees this recovery operation records. */
export function selectPackageActivationNativeRoots(roots: readonly string[]): void {
  packageRoots = roots;
}

/** The package recovery build alone owns this loader; its single-file helper stages no addon. */
export function loadFreeBsdProcessIdentityNative(): typeof import("koffi") {
  // Publication moves the live tree into the anchor before the candidate replaces
  // it, so one recorded tree still carries the installed dependency. Never search
  // the helper's own ancestors: they are unrelated host packages.
  for (const root of packageRoots) {
    const entry = path.join(root, "node_modules", "koffi", "indirect.cjs");
    if (fs.existsSync(entry)) {
      // SAFETY: Koffi exports its typed public API from this installed indirect entry.
      return createRequire(entry)(entry) as typeof import("koffi");
    }
  }
  throw new Error("Package recovery found no recorded FreeBSD native runtime");
}
