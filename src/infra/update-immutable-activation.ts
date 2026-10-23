function unsupported(): never {
  throw new Error(
    "Immutable activation is unavailable in this extended-stable release; preserve the sealed generations and use an immutable-capable updater.",
  );
}

/** Compatibility refusal for 2026.10.1 runtimes crossing into extended-stable. */
export async function activateImmutableUpdate(_options: unknown): Promise<never> {
  return unsupported();
}

/** Compatibility refusal for 2026.10.1 runtimes crossing into extended-stable. */
export async function recoverImmutableUpdate(_options: unknown): Promise<never> {
  return unsupported();
}
