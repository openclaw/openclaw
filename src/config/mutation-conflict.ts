/** Raised when a config write loses an optimistic snapshot race. */
export class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;

  constructor(message: string, params: { currentHash: string | null }) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.currentHash = params.currentHash;
  }
}
