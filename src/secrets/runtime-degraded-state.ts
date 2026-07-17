/** Process-local registry for SecretRef owners isolated during cold startup. */

export type SecretOwnerKind =
  | "account"
  | "capability"
  | "gateway"
  | "provider"
  | "route"
  | "unknown";

export type SecretAssignmentDisposition = "fail-closed" | "isolate";

export type DegradedSecretOwner = {
  ownerKind: Exclude<SecretOwnerKind, "unknown">;
  ownerId: string;
  state: "unavailable";
  paths: string[];
  refKeys: string[];
  reason: string;
};

const SECRET_SURFACE_UNAVAILABLE_ERROR_CODE = "SECRET_SURFACE_UNAVAILABLE";

/** Runtime error returned when a request targets an isolated SecretRef owner. */
export class SecretSurfaceUnavailableError extends Error {
  readonly code = SECRET_SURFACE_UNAVAILABLE_ERROR_CODE;
  readonly ownerKind: DegradedSecretOwner["ownerKind"];
  readonly ownerId: string;
  readonly paths: string[];

  constructor(owner: DegradedSecretOwner) {
    super(
      `Secret owner ${owner.ownerKind}:${owner.ownerId} is configured but unavailable (${owner.reason}).`,
    );
    this.name = "SecretSurfaceUnavailableError";
    this.ownerKind = owner.ownerKind;
    this.ownerId = owner.ownerId;
    this.paths = [...owner.paths];
  }
}

let activeDegradedOwners: DegradedSecretOwner[] = [];

function cloneOwner(owner: DegradedSecretOwner): DegradedSecretOwner {
  return {
    ...owner,
    paths: [...owner.paths],
    refKeys: [...owner.refKeys],
  };
}

/** Publishes the degraded-owner snapshot at the same edge as runtime config activation. */
export function setActiveDegradedSecretOwners(owners: readonly DegradedSecretOwner[]): void {
  activeDegradedOwners = owners.map(cloneOwner);
}

/** Returns the active degraded-owner snapshot without exposing mutable registry state. */
export function listActiveDegradedSecretOwners(): DegradedSecretOwner[] {
  return activeDegradedOwners.map(cloneOwner);
}

/** Returns one active degraded owner, if present. */
export function findActiveDegradedSecretOwner(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): DegradedSecretOwner | undefined {
  const owner = activeDegradedOwners.find(
    (entry) => entry.ownerKind === ownerKind && entry.ownerId === ownerId,
  );
  return owner ? cloneOwner(owner) : undefined;
}

/** Throws the canonical typed error when an owner was isolated at startup. */
export function assertSecretOwnerAvailable(
  ownerKind: DegradedSecretOwner["ownerKind"],
  ownerId: string,
): void {
  const owner = findActiveDegradedSecretOwner(ownerKind, ownerId);
  if (owner) {
    throw new SecretSurfaceUnavailableError(owner);
  }
}
