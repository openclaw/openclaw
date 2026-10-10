import { createRequire } from "node:module";

export function loadProxyline(): typeof import("@openclaw/proxyline") {
  const require = createRequire(import.meta.url);
  // SAFETY: The pinned package's public root is described by this import type.
  return require("@openclaw/proxyline") as typeof import("@openclaw/proxyline");
}
