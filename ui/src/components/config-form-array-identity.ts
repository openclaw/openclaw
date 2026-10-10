import { configValuesEqual } from "./config-form.constraints.ts";

/** One rendered array owns row DOM identity, including unchanged cloned snapshots. */
export class ConfigFormArrayIdentity {
  private readonly identities = new WeakMap<unknown[], readonly symbol[]>();
  private previous: unknown[] = [];

  read(value: unknown[]): readonly symbol[] {
    const existing = this.identities.get(value);
    if (existing?.length === value.length) {
      this.previous = value;
      return existing;
    }
    const previousKeys = this.identities.get(this.previous) ?? [];
    // Reserve unchanged positions so a new equal value cannot steal a survivor's key.
    const remaining = new Set(
      this.previous.flatMap((entry, index) =>
        configValuesEqual(entry, value[index]) ? [] : [index],
      ),
    );
    const keys = value.map((entry, index) => {
      const match = configValuesEqual(entry, this.previous[index])
        ? index
        : [...remaining].find((candidate) => configValuesEqual(entry, this.previous[candidate]));
      if (match === undefined) {
        return Symbol("array-row");
      }
      remaining.delete(match);
      return previousKeys[match]!;
    });
    this.identities.set(value, keys);
    this.previous = value;
    return keys;
  }

  patch(
    value: unknown[],
    keys: readonly symbol[],
    onPatch: (value: unknown[]) => boolean | void,
  ): boolean {
    // Publish tokens before a synchronous render; rejected candidates must not
    // replace the original array's ownership, even when its values are equal.
    const previous = this.previous;
    this.identities.set(value, keys);
    const accepted = onPatch(value) !== false;
    if (!accepted) {
      this.identities.delete(value);
      this.previous = previous;
    }
    return accepted;
  }
}
