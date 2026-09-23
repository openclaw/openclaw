// Creates and applies JSON merge-patch updates to config-like objects.
import { isPlainObject } from "../infra/plain-object.js";
import { isRecord } from "../utils.js";
import { deepEqualStackSafe } from "./deep-equal-stack-safe.js";
import { formatConfigPatchPath, isMergePatchObjectKeyAllowed } from "./patch-replace-paths.js";

type PlainObject = Record<string, unknown>;

type MergePatchOptions = {
  mergeObjectArraysById?: boolean;
  replaceArrayPaths?: ReadonlySet<string>;
  path?: string;
};

type CloneSlot = {
  readonly source: unknown;
  readonly container: Record<string, unknown> | unknown[];
  readonly key: string | number;
};

/**
 * Settles a computed child value into a slot of a freshly built container.
 * Array slots take numeric keys only; record slots settle an authored own
 * `__proto__` key as inert data — assignment would invoke the inherited
 * setter and graft the value onto the container's prototype instead, and
 * the object-builders this replaces kept the key as an own property.
 */
export function settleContainerValue(
  container: Record<string, unknown> | unknown[],
  key: string | number,
  value: unknown,
): void {
  if (Array.isArray(container)) {
    if (typeof key === "number") {
      container[key] = value;
    }
    return;
  }
  if (typeof key !== "string") {
    return;
  }
  if (key === "__proto__") {
    Object.defineProperty(container, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  container[key] = value;
}

function settleCloneSlot(slot: CloneSlot, value: unknown): void {
  settleContainerValue(slot.container, slot.key, value);
}

/**
 * Deep-clones a config value on an explicit work stack. The platform
 * `structuredClone` walks nested containers on the call stack, so a
 * schema-valid deep document overflows before the patch is known. Plain
 * containers clone structurally with a cycle map; anything exotic falls back
 * to `structuredClone` on the single leaf, preserving its copy semantics.
 */
export function cloneUnknown<T>(value: T): T {
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return structuredClone(value);
  }
  const root: Record<string, unknown> = {};
  // Cycle map fills as containers clone; a descendant that references an
  // ancestor settles onto the already-cloned container instead of re-walking.
  const seen = new Map<unknown, unknown>();
  const pending: CloneSlot[] = [{ source: value, container: root, key: "cloned" }];
  while (pending.length > 0) {
    const slot = pending.pop();
    if (slot === undefined) {
      break;
    }
    const source = slot.source;
    if (Array.isArray(source)) {
      const existing = seen.get(source);
      if (existing !== undefined) {
        settleCloneSlot(slot, existing);
        continue;
      }
      const next: unknown[] = Array.from({ length: source.length });
      seen.set(source, next);
      settleCloneSlot(slot, next);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        pending.push({ source: source[index], container: next, key: index });
      }
      continue;
    }
    if (isPlainObject(source)) {
      const existing = seen.get(source);
      if (existing !== undefined) {
        settleCloneSlot(slot, existing);
        continue;
      }
      const next: Record<string, unknown> = {};
      seen.set(source, next);
      settleCloneSlot(slot, next);
      const entries = Object.entries(source);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry === undefined) {
          continue;
        }
        pending.push({ source: entry[1], container: next, key: entry[0] });
      }
      continue;
    }
    if (source !== null && (typeof source === "object" || typeof source === "function")) {
      // Exotic leaf (Date, Map, ...): keep the platform copy semantics; the
      // value is a single node, so the call depth is bounded.
      settleCloneSlot(slot, structuredClone(source));
      continue;
    }
    settleCloneSlot(slot, source);
  }
  // SAFETY: The root slot is first in and settles unconditionally, so
  // `root.cloned` always holds the finished clone when the walk drains.
  return root.cloned as T;
}

/**
 * Frames for the iterative merge-patch walk. `enter` frames diff one node and
 * schedule its keys; `key` frames resolve one key (writing nulls, clones, and
 * scheduling deeper diffs); `array-exit` frames collect the per-entry updates
 * once every id-keyed array entry has diffed. Nesting costs heap rather than
 * call frames, and keys settle in document order.
 */
type MergePatchFrame =
  | {
      readonly kind: "enter";
      readonly base: unknown;
      readonly target: unknown;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
      readonly options: Pick<MergePatchOptions, "mergeObjectArraysById">;
      readonly skipWhenEmpty: boolean;
    }
  | {
      readonly kind: "exit";
      readonly patch: Record<string, unknown>;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
      readonly skipWhenEmpty: boolean;
    }
  | {
      readonly kind: "key";
      readonly base: Record<string, unknown>;
      readonly target: Record<string, unknown>;
      readonly key: string;
      readonly patch: Record<string, unknown>;
      readonly options: Pick<MergePatchOptions, "mergeObjectArraysById">;
    }
  | {
      readonly kind: "array-exit";
      readonly entries: readonly (PlainObject & { id: string })[];
      readonly slots: readonly Record<string, unknown>[];
      readonly container: Record<string, unknown>;
      readonly key: string;
    };

function settleMergePatchFrame(
  frame: Extract<MergePatchFrame, { kind: "enter" | "exit" }>,
  value: unknown,
): void {
  if (Array.isArray(frame.container)) {
    const key = frame.key;
    if (typeof key === "number") {
      frame.container[key] = value;
    }
    return;
  }
  const key = frame.key;
  if (typeof key === "string") {
    frame.container[key] = value;
  }
}

/** Builds a merge patch; ID-keyed array mode emits changed fields for upserts. */
export function createMergePatch(
  base: unknown,
  target: unknown,
  options: Pick<MergePatchOptions, "mergeObjectArraysById"> = {},
): unknown {
  const root: Record<string, unknown> = {};
  const pending: MergePatchFrame[] = [
    { kind: "enter", base, target, container: root, key: "patch", options, skipWhenEmpty: false },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "key") {
      const hasBase = Object.hasOwn(frame.base, frame.key);
      const hasTarget = Object.hasOwn(frame.target, frame.key);
      if (!hasTarget) {
        frame.patch[frame.key] = null;
        continue;
      }
      const targetValue = frame.target[frame.key];
      if (!hasBase) {
        frame.patch[frame.key] = cloneUnknown(targetValue);
        continue;
      }
      const baseValue = frame.base[frame.key];
      if (
        frame.options.mergeObjectArraysById &&
        isIdKeyedArray(baseValue) &&
        isIdKeyedArray(targetValue)
      ) {
        const baseById = new Map(baseValue.map((entry) => [entry.id, entry]));
        const slots = targetValue.map((): Record<string, unknown> => ({}));
        pending.push({
          kind: "array-exit",
          entries: targetValue,
          slots,
          container: frame.patch,
          key: frame.key,
        });
        for (let index = targetValue.length - 1; index >= 0; index -= 1) {
          const entry = targetValue[index];
          const slot = slots[index];
          if (entry === undefined || slot === undefined) {
            continue;
          }
          const baseEntry = baseById.get(entry.id);
          pending.push({
            kind: "enter",
            base: baseEntry,
            target: applyMergePatch(baseEntry, entry, frame.options),
            container: slot,
            key: "update",
            options: frame.options,
            skipWhenEmpty: true,
          });
        }
        continue;
      }
      if (isRecord(baseValue) && isRecord(targetValue)) {
        pending.push({
          kind: "enter",
          base: baseValue,
          target: targetValue,
          container: frame.patch,
          key: frame.key,
          options: frame.options,
          skipWhenEmpty: true,
        });
        continue;
      }
      if (!deepEqualStackSafe(baseValue, targetValue)) {
        frame.patch[frame.key] = cloneUnknown(targetValue);
      }
      continue;
    }
    if (frame.kind === "array-exit") {
      const updates: PlainObject[] = [];
      for (let index = 0; index < frame.entries.length; index += 1) {
        const update = frame.slots[index]!.update;
        if (isRecord(update) && Object.keys(update).length > 0) {
          updates.push({ ...update, id: frame.entries[index]!.id });
        }
      }
      if (updates.length > 0) {
        frame.container[frame.key] = updates;
      }
      continue;
    }
    if (frame.kind === "exit") {
      if (frame.skipWhenEmpty && Object.keys(frame.patch).length === 0) {
        continue;
      }
      settleMergePatchFrame(frame, frame.patch);
      continue;
    }
    if (!isRecord(frame.base) || !isRecord(frame.target)) {
      settleMergePatchFrame(frame, cloneUnknown(frame.target));
      continue;
    }

    const patch: Record<string, unknown> = {};
    // The exit frame settles the parent slot only after every key has diffed,
    // so an empty child patch stays unwritten exactly like the recursive form.
    pending.push({
      kind: "exit",
      patch,
      container: frame.container,
      key: frame.key,
      skipWhenEmpty: frame.skipWhenEmpty,
    });
    const keyList = [...new Set([...Object.keys(frame.base), ...Object.keys(frame.target)])];
    // Pushed in reverse so keys diff (and settle into `patch`) in document order.
    for (let index = keyList.length - 1; index >= 0; index -= 1) {
      const key = keyList[index];
      if (key === undefined) {
        continue;
      }
      pending.push({
        kind: "key",
        base: frame.base,
        target: frame.target,
        key,
        patch,
        options: frame.options,
      });
    }
  }
  return root.patch;
}

/** Whether a merge patch would replace a value changed since its source was read. */
export function mergePatchConflicts(
  base: unknown,
  current: unknown,
  patch: unknown,
  options: Pick<MergePatchOptions, "mergeObjectArraysById"> = {},
): boolean {
  // Boolean predicate over the patch tree on an explicit work stack: any node
  // that reports a conflict short-circuits the whole walk, and document
  // nesting costs heap rather than call frames.
  const pending: Array<{ base: unknown; current: unknown; patch: unknown }> = [
    { base, current, patch },
  ];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    if (
      options.mergeObjectArraysById &&
      isIdKeyedArray(node.base) &&
      isIdKeyedArray(node.current) &&
      isIdKeyedArray(node.patch)
    ) {
      const baseById = new Map(node.base.map((entry) => [entry.id, entry]));
      const currentById = new Map(node.current.map((entry) => [entry.id, entry]));
      for (const entry of node.patch) {
        pending.push({
          base: baseById.get(entry.id),
          current: currentById.get(entry.id),
          patch: entry,
        });
      }
      continue;
    }
    if (!isRecord(node.patch)) {
      if (!deepEqualStackSafe(node.base, node.current)) {
        return true;
      }
      continue;
    }
    const baseIsObject = isRecord(node.base);
    const currentIsObject = isRecord(node.current);
    if (baseIsObject !== currentIsObject && node.base !== undefined) {
      return true;
    }
    if (!baseIsObject && !currentIsObject && !deepEqualStackSafe(node.base, node.current)) {
      return true;
    }
    const baseRecord = isRecord(node.base) ? node.base : {};
    const currentRecord = isRecord(node.current) ? node.current : {};
    for (const [key, childPatch] of Object.entries(node.patch)) {
      pending.push({
        base: baseRecord[key],
        current: currentRecord[key],
        patch: childPatch,
      });
    }
  }
  return false;
}

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.id === "string" && value.id.length > 0;
}

function isIdKeyedArray(value: unknown): value is (PlainObject & { id: string })[] {
  return Array.isArray(value) && value.every(isObjectWithStringId);
}

function formatMergePatchArrayEntryPath(arrayPath: string): string {
  return `${arrayPath}[]`;
}

/**
 * Merge arrays of object-like entries keyed by `id`.
 *
 * Contract:
 * - Base array must be fully id-keyed; otherwise return undefined (caller should replace).
 * - Patch entries with valid id merge by id (or append when the id is new).
 * - Patch entries without valid id append as-is, avoiding destructive full-array replacement.
 */
function mergeObjectArraysById(
  base: unknown[],
  patch: unknown[],
  options: MergePatchOptions,
  arrayPath: string,
): unknown[] | undefined {
  if (!base.every(isObjectWithStringId)) {
    return undefined;
  }

  const merged: unknown[] = [...base];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (!isObjectWithStringId(entry)) {
      return undefined;
    }
    indexById.set(entry.id, index);
  }

  for (const patchEntry of patch) {
    if (!isObjectWithStringId(patchEntry)) {
      merged.push(cloneUnknown(patchEntry));
      continue;
    }

    const existingIndex = indexById.get(patchEntry.id);
    if (existingIndex === undefined) {
      merged.push(cloneUnknown(patchEntry));
      indexById.set(patchEntry.id, merged.length - 1);
      continue;
    }

    merged[existingIndex] = applyMergePatch(merged[existingIndex], patchEntry, {
      ...options,
      path: formatMergePatchArrayEntryPath(arrayPath),
    });
  }

  return merged;
}

/**
 * Applies an RFC 7396-style object merge patch with OpenClaw config safeguards.
 *
 * Non-object patches replace the base, `null` deletes keys, blocked prototype
 * keys are ignored outside schema-owned record-key paths, and id-keyed arrays
 * may merge when the caller opts in.
 */
/**
 * Frames for the iterative merge-patch application. `enter` frames prepare one
 * result container and schedule its patch keys; `apply-key` frames resolve one
 * key (deletes, array merges, leaf writes, or a deeper enter). Keys settle in
 * document order and nesting costs heap rather than call frames.
 */
type ApplyMergePatchFrame =
  | {
      readonly kind: "enter";
      readonly base: unknown;
      readonly patch: Record<string, unknown>;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
      readonly options: MergePatchOptions;
    }
  | {
      readonly kind: "apply-key";
      readonly baseValue: unknown;
      readonly value: unknown;
      readonly key: string;
      readonly result: PlainObject;
      readonly options: MergePatchOptions;
    };

function settleApplyMergePatchFrame(
  frame: Extract<ApplyMergePatchFrame, { kind: "enter" }>,
  value: unknown,
): void {
  if (Array.isArray(frame.container)) {
    const key = frame.key;
    if (typeof key === "number") {
      frame.container[key] = value;
    }
    return;
  }
  const key = frame.key;
  if (typeof key === "string") {
    frame.container[key] = value;
  }
}

/** Applies one patch key against its base value inside the result container. */
function applyMergePatchKey(
  pending: ApplyMergePatchFrame[],
  frame: Extract<ApplyMergePatchFrame, { kind: "apply-key" }>,
): void {
  const path = formatConfigPatchPath(frame.options.path, frame.key);
  if (!isMergePatchObjectKeyAllowed(frame.key, frame.options.path)) {
    return;
  }
  if (frame.value === null) {
    delete frame.result[frame.key];
    return;
  }
  if (
    frame.options.mergeObjectArraysById &&
    Array.isArray(frame.baseValue) &&
    Array.isArray(frame.value)
  ) {
    if (frame.options.replaceArrayPaths?.has(path)) {
      frame.result[frame.key] = frame.value;
      return;
    }
    // Config arrays like agents/plugins can patch by id; non-id arrays keep RFC replacement.
    const mergedArray = mergeObjectArraysById(frame.baseValue, frame.value, frame.options, path);
    if (mergedArray) {
      frame.result[frame.key] = mergedArray;
      return;
    }
  }
  if (isPlainObject(frame.value)) {
    pending.push({
      kind: "enter",
      base: isPlainObject(frame.baseValue) ? frame.baseValue : {},
      patch: frame.value,
      container: frame.result,
      key: frame.key,
      options: { ...frame.options, path },
    });
    return;
  }
  frame.result[frame.key] = frame.value;
}

/**
 * Applies an RFC 7396-style object merge patch with OpenClaw config safeguards.
 *
 * Non-object patches replace the base, `null` deletes keys, blocked prototype
 * keys are ignored outside schema-owned record-key paths, and id-keyed arrays
 * may merge when the caller opts in.
 */
export function applyMergePatch(
  base: unknown,
  patch: unknown,
  options: MergePatchOptions = {},
): unknown {
  if (!isPlainObject(patch)) {
    return patch;
  }
  const root: Record<string, unknown> = {};
  const pending: ApplyMergePatchFrame[] = [
    { kind: "enter", base, patch, container: root, key: "result", options },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "apply-key") {
      applyMergePatchKey(pending, frame);
      continue;
    }
    const result: PlainObject = isPlainObject(frame.base) ? { ...frame.base } : {};
    settleApplyMergePatchFrame(frame, result);
    const entries = Object.entries(frame.patch);
    // Pushed in reverse so keys apply (and settle into `result`) in document order.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }
      pending.push({
        kind: "apply-key",
        baseValue: result[entry[0]],
        value: entry[1],
        key: entry[0],
        result,
        options: frame.options,
      });
    }
  }
  return root.result;
}
