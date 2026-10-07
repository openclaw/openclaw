import { createRequire } from "node:module";

export function loadProxyline(): typeof import("@openclaw/proxyline") {
  // SAFETY: The pinned package's public root is described by this import type.
  return createRequire(import.meta.url)(
    "@openclaw/proxyline",
  ) as typeof import("@openclaw/proxyline");
}
