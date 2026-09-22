import type { GatewaySessionRow } from "../api/types.ts";
import {
  areUiSessionKeysEquivalent,
  isSubagentSessionKey,
  resolveUiSessionNavigationParentKey,
} from "../lib/sessions/session-key.ts";

/** Resolve visual placement without changing persisted routing or transcript ancestry. */
export function resolveSidebarSessionParentKey(
  row: GatewaySessionRow | undefined,
  mainSessionKeys: ReadonlySet<string>,
  listedParentKey?: string,
): string | undefined {
  const parentKey = resolveUiSessionNavigationParentKey(row) ?? listedParentKey;
  // Operator roots carry an implicit Home link for notices. Explicit creation
  // records the parent's generation; delegation and forks have their own markers.
  // Older rows without creation provenance keep their existing placement.
  if (
    parentKey &&
    row?.createdVia === "operator" &&
    row.spawnDepth === 0 &&
    !row.parentSessionId &&
    !row.spawnedBy &&
    !row.forkSource &&
    row.forkedFromParent !== true &&
    !isSubagentSessionKey(row.key) &&
    [...mainSessionKeys].some((key) => areUiSessionKeysEquivalent(key, parentKey))
  ) {
    return undefined;
  }
  return parentKey;
}
