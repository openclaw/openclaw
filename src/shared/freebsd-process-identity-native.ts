import { createRequire } from "node:module";

declare const SEALED_RUNTIME_BUILD: boolean;

type IdentityModule = typeof import("@openclaw/proc-safe/identity");
let identity: IdentityModule | undefined;

/** Normal installations use the dependency's public loader. */
export function loadFreeBsdProcessIdentityNative(): typeof import("@openclaw/proc-safe/identity") {
  // Sealed recovery builds substitute their own loader. Other sealed runtimes
  // must not resolve optional native code on the host.
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    throw new Error("FreeBSD process identity is unavailable in this sealed runtime");
  }
  if (!identity) {
    const require = createRequire(import.meta.url);
    // SAFETY: The installed public subpath owns the typed process identity API.
    identity = require("@openclaw/proc-safe/identity") as IdentityModule;
  }
  return identity;
}
