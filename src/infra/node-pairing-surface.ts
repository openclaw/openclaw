import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export type NodeApprovalSurface = {
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
};

export function intersectNodePermissionSurface(params: {
  approved: Record<string, boolean> | undefined;
  declared: Record<string, boolean> | undefined;
}): Record<string, boolean> | undefined {
  const entries: Array<[string, boolean]> = [];
  for (const [key, declaredValue] of Object.entries(params.declared ?? {})) {
    const approvedValue = params.approved?.[key];
    if (!declaredValue) {
      entries.push([key, false]);
    } else if (approvedValue !== undefined) {
      entries.push([key, approvedValue]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Normalize capability/command lists for node approval-surface comparison. */
export function normalizeNodeApprovalSurfaceList(value: readonly string[] | undefined): string[] {
  return normalizeArrayBackedTrimmedStringList(value) ?? [];
}

/** Compare capability/command surfaces as normalized sets, ignoring order and duplicates. */
export function sameNodeApprovalSurfaceSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = new Set(normalizeNodeApprovalSurfaceList(left));
  const normalizedRight = new Set(normalizeNodeApprovalSurfaceList(right));
  return (
    normalizedLeft.size === normalizedRight.size &&
    [...normalizedLeft].every((entry) => normalizedRight.has(entry))
  );
}

/** Compare node permission maps deterministically so key order cannot trigger repairs. */
export function sameNodePermissionSurface(
  left: Record<string, boolean> | undefined,
  right: Record<string, boolean> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightPermissions = right ?? {};
  return (
    leftEntries.length === Object.keys(rightPermissions).length &&
    leftEntries.every(
      ([key, value]) => Object.hasOwn(rightPermissions, key) && rightPermissions[key] === value,
    )
  );
}
