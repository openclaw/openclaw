/** Shared per-runtime cache for resolved SecretRefs and file provider payloads. */
export type SecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  filePayloadByProvider?: Map<string, Promise<unknown>>;
};
