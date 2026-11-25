import type { refResolutionError } from "./resolve-errors.js";

/** Throws in strict resolution; records a ref failure when settling an owner batch. */
export type SecretRefErrorHandler = (error: ReturnType<typeof refResolutionError>) => void;

/** Shared per-runtime cache for resolved SecretRefs and file provider payloads. */
export type SecretRefResolveCache = {
  /** In-flight or completed resolution promise keyed by `secretRefKey(ref)`. */
  resolvedByRefKey?: Map<string, Promise<unknown>>;
  /** In-flight or completed parsed file-provider payload keyed by provider alias. */
  filePayloadByProvider?: Map<string, Promise<unknown>>;
};
