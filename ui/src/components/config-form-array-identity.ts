// Control UI helpers create repeated-row identities for array renderers.
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-value";
import { configArrayRowStates } from "../lib/config/config-array-row-state.ts";

export function rowIdentitiesForArray(value: unknown[]): readonly unknown[] {
  const existing = configArrayRowStates.get(value)?.identities;
  if (existing?.length === value.length) {
    return existing;
  }
  const created = Array.from(value, () => Symbol("array-row"));
  preserveArrayRowIdentities(value, created);
  return created;
}

export function preserveArrayRowIdentities(value: unknown[], identities: readonly unknown[]): void {
  configArrayRowStates.set(value, {
    identities,
    preserve(target, visit) {
      if (identities.length !== value.length) {
        return;
      }
      if (value.length === target.length) {
        // Same-length snapshots preserve unchanged corresponding rows by position.
        preserveArrayRowIdentities(
          target,
          target.map((nextValue, index) => {
            const previousValue = value[index];
            // The canonical comparator is asymmetric, so check both directions.
            if (
              !jsonSchemaValuesEqual(previousValue, nextValue) ||
              !jsonSchemaValuesEqual(nextValue, previousValue)
            ) {
              return Symbol("array-row");
            }
            visit(previousValue, nextValue);
            return identities[index];
          }),
        );
        return;
      }
      // When lengths differ (append/removal during save replay), match survivors
      // by value so untouched invalid drafts keep their controls and error state.
      const used = new Set<number>();
      preserveArrayRowIdentities(
        target,
        target.map((nextValue) => {
          for (let index = 0; index < value.length; index++) {
            if (used.has(index)) {
              continue;
            }
            const previousValue = value[index];
            if (
              jsonSchemaValuesEqual(previousValue, nextValue) &&
              jsonSchemaValuesEqual(nextValue, previousValue)
            ) {
              used.add(index);
              visit(previousValue, nextValue);
              return identities[index];
            }
          }
          return Symbol("array-row");
        }),
      );
    },
  });
}

export function discardArrayRowIdentities(value: unknown[]): void {
  configArrayRowStates.delete(value);
}

export function appendArrayRowIdentities(
  nextValue: unknown[],
  identities: readonly unknown[],
  count: number,
): void {
  // Appending an equal value must not reuse a removed row's identity.
  const appended = Array.from({ length: count }, () => Symbol("array-row"));
  preserveArrayRowIdentities(nextValue, [...identities, ...appended]);
}
