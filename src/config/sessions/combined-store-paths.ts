import { expectDefined } from "@openclaw/normalization-core";
import type { SessionStoreTarget } from "./targets.js";

export function storeTargetKey(target: SessionStoreTarget): string {
  return `${target.agentId}\0${target.storePath}`;
}

// Template-backed stores need per-agent scans before they can be merged for Gateway views.
export function isStorePathTemplate(store?: string): boolean {
  return typeof store === "string" && store.includes("{agentId}");
}

export function resolveCombinedStorePath(paths: string[], storeConfig?: string): string {
  return paths.length === 1
    ? expectDefined(paths[0], "store path at 0")
    : typeof storeConfig === "string" && storeConfig.trim()
      ? storeConfig.trim()
      : "(multiple)";
}

export function resolveCombinedDatabasePath(
  targets: readonly SessionStoreTarget[],
  physicalTargets: ReadonlyMap<string, SessionStoreTarget>,
): string {
  const paths = [
    ...new Set(
      targets.map(
        (target) =>
          expectDefined(physicalTargets.get(storeTargetKey(target)), "physical store").storePath,
      ),
    ),
  ];
  return paths.length === 1 ? expectDefined(paths[0], "database path at 0") : "(multiple)";
}
