// Browser snapshot schemas project durable display data, stripping live-only
// fields unless the owning envelope explicitly requires an exact shape.
export type SnapshotReader<T> = { parse: (value: unknown) => T; optional?: true };
export type SnapshotValue<R> = R extends SnapshotReader<infer T> ? T : never;

type Shape = Record<string, SnapshotReader<unknown>>;
export type SnapshotObject<S extends Shape> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: SnapshotValue<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: SnapshotValue<S[K]>;
};

function invalid(): never {
  throw new TypeError("Invalid persisted UI snapshot");
}

export function checked<T>(check: (value: unknown) => value is T): SnapshotReader<T> {
  return { parse: (value) => (check(value) ? value : invalid()) };
}

export const text = checked((value): value is string => typeof value === "string");
export const number = checked(
  (value): value is number => typeof value === "number" && Number.isFinite(value),
);
export const boolean = checked((value): value is boolean => typeof value === "boolean");
export const unknown: SnapshotReader<unknown> = { parse: (value) => value };
export const never = checked((_value): _value is never => false);

export function literal<const T extends string | number | boolean>(expected: T): SnapshotReader<T> {
  return checked((value): value is T => value === expected);
}

export function enumeration<const T extends string>(values: readonly T[]): SnapshotReader<T> {
  return checked((value): value is T => values.some((item) => item === value));
}

export function optional<T>(
  reader: SnapshotReader<T>,
): SnapshotReader<T | undefined> & { optional: true } {
  return {
    optional: true,
    parse: (value) => (value === undefined ? undefined : reader.parse(value)),
  };
}

export function nullable<T>(reader: SnapshotReader<T>): SnapshotReader<T | null> {
  return { parse: (value) => (value === null ? null : reader.parse(value)) };
}

export function defaulted<T>(
  reader: SnapshotReader<T>,
  fallback: () => NoInfer<T>,
): SnapshotReader<T> {
  return { parse: (value) => (value === undefined ? fallback() : reader.parse(value)) };
}

export function refine<T>(
  reader: SnapshotReader<T>,
  check: (value: T) => boolean,
): SnapshotReader<T> {
  return {
    parse(value) {
      const parsed = reader.parse(value);
      return check(parsed) ? parsed : invalid();
    },
  };
}

export function array<T>(reader: SnapshotReader<T>, max = Infinity): SnapshotReader<T[]> {
  return {
    parse(value) {
      if (!Array.isArray(value) || value.length > max) {
        return invalid();
      }
      return Array.from(value, (item) => reader.parse(item));
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  // SAFETY: the object boundary is checked above; field values remain unknown.
  return value as Record<string, unknown>;
}

export function object<S extends Shape>(
  shape: S,
  strict = false,
): SnapshotReader<SnapshotObject<S>> {
  const fields = Object.entries(shape);
  return {
    parse(value) {
      const source = recordValue(value);
      if (strict) {
        for (const key in source) {
          if (!Object.hasOwn(shape, key)) {
            return invalid();
          }
        }
      }
      const result: Record<string, unknown> = {};
      for (const [key, reader] of fields) {
        if (key === "__proto__") {
          continue;
        }
        const parsed = reader.parse(source[key]);
        if (parsed === undefined && !(key in source) && !reader.optional) {
          return invalid();
        }
        if (parsed !== undefined || key in source) {
          result[key] = parsed;
        }
      }
      // SAFETY: every declared field has passed its reader; only optional keys can be absent.
      return result as SnapshotObject<S>;
    },
  };
}

export function record<T>(reader: SnapshotReader<T>): SnapshotReader<Record<string, T>> {
  return {
    parse(value) {
      const source = recordValue(value);
      const constructor = source.constructor;
      if (typeof constructor === "function") {
        const prototype: unknown = constructor.prototype;
        if (
          typeof prototype !== "object" ||
          prototype === null ||
          !Object.hasOwn(prototype, "isPrototypeOf")
        ) {
          return invalid();
        }
      }
      const result: Record<string, T> = {};
      for (const key of Reflect.ownKeys(source)) {
        if (key === "__proto__" || !Object.prototype.propertyIsEnumerable.call(source, key)) {
          continue;
        }
        if (typeof key !== "string") {
          return invalid();
        }
        result[key] = reader.parse(source[key]);
      }
      return result;
    },
  };
}

export function lazy<T>(reader: () => SnapshotReader<T>): SnapshotReader<T> {
  let resolved: SnapshotReader<T> | undefined;
  return { parse: (value) => (resolved ??= reader()).parse(value) };
}

export function pair<A, B>(
  first: SnapshotReader<A>,
  second: SnapshotReader<B>,
): SnapshotReader<[A, B]> {
  return {
    parse(value) {
      if (!Array.isArray(value) || value.length !== 2) {
        return invalid();
      }
      return [first.parse(value[0]), second.parse(value[1])];
    },
  };
}

export function parseSnapshot<T>(reader: SnapshotReader<T>, value: unknown): T | null {
  try {
    return reader.parse(value);
  } catch {
    return null;
  }
}
