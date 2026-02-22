/**
 * Prototype pollution detection for plugin loading.
 *
 * Instead of freezing Object.prototype (which breaks many libraries),
 * take a snapshot before plugin load and verify no properties were added
 * after plugin registration.
 */

type PrototypeSnapshot = ReadonlySet<string>;

const MONITORED_PROTOTYPES: readonly [string, object][] = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
  ["String.prototype", String.prototype],
];

/**
 * Take a snapshot of all own property names on monitored prototypes.
 */
export function snapshotPrototypes(): Map<string, PrototypeSnapshot> {
  const snapshots = new Map<string, PrototypeSnapshot>();
  for (const [name, proto] of MONITORED_PROTOTYPES) {
    snapshots.set(name, new Set(Object.getOwnPropertyNames(proto)));
  }
  return snapshots;
}

/**
 * Check if any monitored prototypes have been polluted since the snapshot.
 *
 * Returns an array of pollution descriptions, or empty array if clean.
 */
export function detectPrototypePollution(snapshot: Map<string, PrototypeSnapshot>): string[] {
  const violations: string[] = [];
  for (const [name, proto] of MONITORED_PROTOTYPES) {
    const before = snapshot.get(name);
    if (!before) {
      continue;
    }
    const current = Object.getOwnPropertyNames(proto);
    for (const prop of current) {
      if (!before.has(prop)) {
        violations.push(`${name}.${prop} was added (prototype pollution)`);
      }
    }
  }
  return violations;
}

/**
 * Freeze non-prototype global objects that are safe to freeze.
 * These don't typically break library code.
 */
export function freezeSafeGlobals(): void {
  Object.freeze(JSON);
  Object.freeze(Math);
  Object.freeze(Reflect);
}
