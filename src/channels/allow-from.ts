export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries = params.dmPolicy === "allowlist" ? [] : (params.storeAllowFrom ?? []);
  return [...(params.allowFrom ?? []), ...storeEntries]
    .map((value) => String(value).trim())
    .filter(Boolean);
}

export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
  fallbackToAllowFrom?: boolean;
  /** Include pairing store in group auth. Defaults to true for backward compatibility. */
  groupAuthIncludesPairingStore?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  // Include pairing store in group auth for backward compatibility.
  // Users who paired via DM should be allowed in group chats.
  // When dmPolicy is "allowlist", the pairing store is not used (explicit allowlist only).
  // When fallbackToAllowFrom is explicitly disabled, also exclude pairing store by default
  // (channels using strict group allowlists likely want fully explicit group access).
  // Users can override by setting groupAuthIncludesPairingStore explicitly.
  // See: https://github.com/openclaw/openclaw/issues/24571
  const defaultIncludePairingStore = params.fallbackToAllowFrom !== false;
  const includePairingStore = params.groupAuthIncludesPairingStore ?? defaultIncludePairingStore;
  const storeEntries =
    !includePairingStore || params.dmPolicy === "allowlist" ? [] : (params.storeAllowFrom ?? []);
  return [...scoped, ...storeEntries].map((value) => String(value).trim()).filter(Boolean);
}

export function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
}

export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
