/** Remote settlement fulfills after native launch or fenced refusal; rejection retains custody. */
export type SpawnInitiation = <T>(launch: () => T, settlement?: Promise<unknown>) => T;
