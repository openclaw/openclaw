import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export function normalizeDevicePairingRole(role: string | undefined): string | null {
  const trimmed = role?.trim();
  return trimmed ? trimmed : null;
}

/** Merge pairing roles while preserving first-seen order. */
export function mergeDevicePairingRoles(
  ...items: Array<string | string[] | undefined>
): string[] | undefined {
  const roles = [...new Set(items.flatMap(normalizeUniqueSingleOrTrimmedStringList))];
  return roles.length > 0 ? roles : undefined;
}
