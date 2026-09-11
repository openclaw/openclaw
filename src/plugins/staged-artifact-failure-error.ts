import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";

/**
 * Thrown when staged-artifact validation fails before the installer publishes
 * the replacement. The staging mechanism (`installPackageDir`) cleans its
 * temporary stage directory without touching the target, so the prior install
 * survives. This lets the updater distinguish a non-destructive staging failure
 * from other exceptions whose effect on the prior install is unknown.
 */
export class StagedArtifactFailureError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = "StagedArtifactFailureError";
  }
}

/**
 * Classifies an error captured inside the managed-npm staging callback.
 * Typed lifecycle errors (e.g. capability-consent rejection) pass through
 * unwrapped so downstream `instanceof` checks and Gateway consent responses
 * remain intact. All other staging failures are wrapped in
 * `StagedArtifactFailureError` so the updater can distinguish this confirmed
 * non-destructive case from unclassified exceptions.
 */
export function classifyStagedArtifactFailure(cause: unknown): never {
  if (cause instanceof ManagedPluginLifecycleError) {
    throw cause;
  }
  throw new StagedArtifactFailureError(cause);
}
