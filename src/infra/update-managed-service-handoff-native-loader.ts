import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

let identity: typeof import("@openclaw/proc-safe/identity") | undefined;

/** The handoff build alone owns this loader beside its staged native package. */
export function loadFreeBsdProcessIdentityNative(): typeof import("@openclaw/proc-safe/identity") {
  // SAFETY: This adds only an optional unknown field; every defined value is rejected.
  if ((process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath !== undefined) {
    throw new Error("Managed handoff cannot use an external FreeBSD native resource path");
  }
  if (identity) {
    return identity;
  }
  const entry = fileURLToPath(
    new URL("./node_modules/@openclaw/proc-safe/dist/identity.js", import.meta.url),
  );
  const require = createRequire(entry);
  const platformName = `@openclaw/proc-safe-freebsd-${process.arch}`;
  const nativeEntry = path.resolve(
    path.dirname(entry),
    "../..",
    `proc-safe-freebsd-${process.arch}`,
    "proc-safe-native.node",
  );
  // A missing private addon must never fall through to an ancestor or NODE_PATH.
  if (
    require.resolve(platformName) !== nativeEntry ||
    fs.realpathSync(nativeEntry) !== nativeEntry
  ) {
    throw new Error("Managed handoff cannot use an external FreeBSD native runtime");
  }
  // SAFETY: Staging validates this public entry and its private platform addon.
  return (identity = require(entry) as typeof import("@openclaw/proc-safe/identity"));
}
