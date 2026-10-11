import { createRequire } from "node:module";

declare const SEALED_RUNTIME_BUILD: boolean;

/** Normal installations use the dependency's public loader. */
export function loadFreeBsdProcessIdentityNative(): typeof import("koffi") {
  // Sealed recovery builds substitute their own loader. Other sealed runtimes
  // must not resolve optional native code on the host.
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    throw new Error("FreeBSD process identity is unavailable in this sealed runtime");
  }
  // SAFETY: Koffi exports its typed public API from this installed indirect entry.
  return createRequire(import.meta.url)("koffi/indirect") as typeof import("koffi");
}
