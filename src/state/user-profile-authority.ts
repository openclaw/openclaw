export type ProfileAuthorityDescriptor = {
  generation: SharedArrayBuffer;
  lifetime: { revision: SharedArrayBuffer; epoch: bigint };
  entries: readonly { state: SharedArrayBuffer; revision?: number }[];
};

export type ProfileAuthorityStatus = "current" | "pending" | "uncertain" | "revoked";

/** Cells belong to the canonical profile writer; delivery never grants or revives authority. */
export function readProfileAuthority(
  descriptor: ProfileAuthorityDescriptor,
): ProfileAuthorityStatus {
  const generation = new Int32Array(descriptor.generation);
  const lifetime = new BigInt64Array(descriptor.lifetime.revision);
  if (
    Atomics.load(lifetime, 0) !== descriptor.lifetime.epoch ||
    Atomics.load(generation, 0) !== 1
  ) {
    return "revoked";
  }
  const publication = Atomics.load(generation, 1);
  if (publication % 2 !== 0) {
    return "pending";
  }
  let status: ProfileAuthorityStatus = "current";
  for (const entry of descriptor.entries) {
    const cell = new Int32Array(entry.state);
    const current = Atomics.load(cell, 0);
    const state = Atomics.load(cell, 1);
    if (entry.revision !== undefined && current !== entry.revision) {
      status = "revoked";
    } else if (state === 2 && status !== "revoked") {
      status = "uncertain";
    } else if (state === 1 && status === "current") {
      status = "pending";
    } else if (state !== 0 && state !== 1 && state !== 2) {
      status = "revoked";
    }
  }
  if (
    Atomics.load(lifetime, 0) !== descriptor.lifetime.epoch ||
    Atomics.load(generation, 0) !== 1
  ) {
    return "revoked";
  }
  return Atomics.load(generation, 1) === publication ? status : "pending";
}
