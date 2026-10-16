import { isPlainObject } from "./plain-object.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type DeepMergeOptions = {
  arrays?: "replace" | "concat";
  undefinedValues?: "skip" | "replace";
};

type MergeFrame = { target: Record<string, unknown>; source: Record<string, unknown> };

// Deep clone that drops blocked object keys. Iterative: each nested container
// becomes a heap frame instead of a call frame, so document depth costs heap
// and previously accepted deep configs keep cloning instead of overflowing
// the call stack.
function sanitizePlainObject(value: Record<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ src: Record<string, unknown>; dst: Record<string, unknown> }> = [
    { src: value, dst: root },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const [key, entry] of Object.entries(frame.src)) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      if (isPlainObject(entry)) {
        const child: Record<string, unknown> = {};
        frame.dst[key] = child;
        stack.push({ src: entry, dst: child });
        continue;
      }
      frame.dst[key] = entry;
    }
  }
  return root;
}

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

  // Clone nested records before merging so base-only and override-only branches
  // enforce the same blocked-key boundary.
  const result = sanitizePlainObject(base);
  // Driver loop: each pending (target, source) container pair becomes a heap
  // frame instead of a call frame, so document depth costs heap and previously
  // accepted deep configs keep merging instead of overflowing the call stack.
  const stack: Array<MergeFrame> = [{ target: result, source: override }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    for (const [key, value] of Object.entries(frame.source)) {
      if (isBlockedObjectKey(key) || (value === undefined && undefinedValues === "skip")) {
        continue;
      }
      const current = frame.target[key];
      if (isPlainObject(value)) {
        if (isPlainObject(current)) {
          // `current` already lives in the sanitized clone tree produced above,
          // so its blocked keys are gone and no second pass is needed.
          stack.push({ target: current, source: value });
          continue;
        }
        frame.target[key] = sanitizePlainObject(value);
        continue;
      }
      if (arrays === "concat" && Array.isArray(current) && Array.isArray(value)) {
        frame.target[key] = [...current, ...value];
        continue;
      }
      frame.target[key] = value;
    }
  }
  return result;
}
