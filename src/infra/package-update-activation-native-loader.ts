import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

type IdentityModule = typeof import("@openclaw/proc-safe/identity");
let packageRoots: readonly string[] = [];
let identity: IdentityModule | undefined;

/** Bind FreeBSD process identity to the package trees this recovery operation records. */
export function selectPackageActivationNativeRoots(roots: readonly string[]): void {
  packageRoots = roots;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** The package recovery build alone owns this loader; its single-file helper stages no addon. */
export function loadFreeBsdProcessIdentityNative(): typeof import("@openclaw/proc-safe/identity") {
  if (identity) {
    return identity;
  }
  // Publication moves the live tree into the anchor before the candidate replaces
  // it, so one recorded tree still carries the installed dependency. Never search
  // the helper's own ancestors: they are unrelated host packages.
  for (const root of packageRoots) {
    const candidate = path.join(
      root,
      "node_modules",
      "@openclaw",
      "proc-safe",
      "dist",
      "identity.js",
    );
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const realRoot = fs.realpathSync(root);
    const entry = fs.realpathSync(candidate);
    const require = createRequire(entry);
    let nativeEntry: string;
    try {
      nativeEntry = fs.realpathSync(require.resolve(`@openclaw/proc-safe-freebsd-${process.arch}`));
    } catch {
      continue;
    }
    // proc-safe resolves its addon from its own directory, so a tree missing the
    // platform package would otherwise fall through to an ancestor node_modules.
    if (isInside(realRoot, entry) && isInside(realRoot, nativeEntry)) {
      // SAFETY: The recorded tree's public entry and private platform addon are checked above.
      return (identity = require(entry) as IdentityModule);
    }
  }
  throw new Error("Package recovery found no recorded FreeBSD native runtime");
}
