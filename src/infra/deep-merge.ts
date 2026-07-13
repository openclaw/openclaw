// @ts-expect-error defu 6.1.5's export= declaration hides its shipped ESM named exports.
import { createDefu } from "defu";
import { isPlainObject } from "./plain-object.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export type DeepMergeOptions = {
  arrays?: "replace" | "concat";
  undefinedValues?: "skip" | "replace";
};

const NULL_OVERRIDE = Symbol("null-override");
const UNDEFINED_OVERRIDE = Symbol("undefined-override");

function prepareObject(
  value: Record<string, unknown>,
  undefinedValues: "skip" | "replace",
  encodeOverrides: boolean,
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (encodeOverrides && entry === null) {
      prepared[key] = NULL_OVERRIDE;
    } else if (encodeOverrides && entry === undefined && undefinedValues === "replace") {
      prepared[key] = UNDEFINED_OVERRIDE;
    } else if (isPlainObject(entry)) {
      prepared[key] = prepareObject(entry, undefinedValues, encodeOverrides);
    } else {
      prepared[key] = entry;
    }
  }
  return prepared;
}

function decodeOverrides(value: unknown): unknown {
  if (value === NULL_OVERRIDE) {
    return null;
  }
  if (value === UNDEFINED_OVERRIDE) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeOverrides(entry)]),
  );
}

function createObjectMerger(arrays: "replace" | "concat") {
  return createDefu(
    (object: Record<PropertyKey, unknown>, key: PropertyKey, value: unknown) => {
      const target = object;
      if (typeof key === "string" && isBlockedObjectKey(key)) {
        return true;
      }
      if (value === NULL_OVERRIDE) {
        target[key] = null;
        return true;
      }
      if (value === UNDEFINED_OVERRIDE) {
        target[key] = undefined;
        return true;
      }
      if (!Array.isArray(value)) {
        return false;
      }
      if (arrays === "replace") {
        target[key] = value;
        return true;
      }
      const existing = target[key];
      if (Array.isArray(existing)) {
        target[key] = [...existing, ...value];
        return true;
      }
      return false;
    },
  );
}

const mergeReplacingArrays = createObjectMerger("replace");
const mergeConcatenatingArrays = createObjectMerger("concat");

/** Merge plain objects while preserving OpenClaw's null, undefined, and array policies. */
export function mergeDeep(
  base: unknown,
  override: unknown,
  options: DeepMergeOptions = {},
): unknown {
  const arrays = options.arrays ?? "replace";
  const undefinedValues = options.undefinedValues ?? "skip";

  if (Array.isArray(base) && Array.isArray(override)) {
    return arrays === "concat" ? [...base, ...override] : override;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined && undefinedValues === "skip" ? base : override;
  }

  // defu intentionally treats null/undefined as absent. Sentinels retain explicit
  // overrides while its recursive merge remains the single merge implementation.
  const preparedBase = prepareObject(base, undefinedValues, false);
  const preparedOverride = prepareObject(override, undefinedValues, true);
  const merge = arrays === "concat" ? mergeConcatenatingArrays : mergeReplacingArrays;
  return decodeOverrides(merge(preparedOverride, preparedBase));
}
