import { wrapFetchWithEgressAudit } from "./fetch-egress-audit.js";

let didPatch = false;

export function patchGlobalFetchForEgressAudit() {
  if (didPatch) {
    return;
  }
  didPatch = true;

  const g = globalThis as typeof globalThis & { fetch?: typeof fetch };
  if (typeof g.fetch !== "function") {
    return;
  }

  g.fetch = wrapFetchWithEgressAudit(g.fetch.bind(globalThis));
}
