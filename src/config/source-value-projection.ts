import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deepEqualStackSafe } from "./deep-equal-stack-safe.js";
import { cloneUnknown } from "./merge-patch.js";
import { formatConfigPatchPath, isMergePatchObjectKeyAllowed } from "./patch-replace-paths.js";

/**
 * Frames for the iterative runtime-edit projection. `enter` frames project one
 * node and schedule its keys; `project-key` frames resolve one key's child
 * result; `project-exit` frames apply the collected child outcomes to the
 * projected record and settle either it or the unchanged sentinel. Nesting
 * costs heap rather than call frames.
 */
type ProjectionFrame =
  | {
      readonly kind: "enter";
      readonly source: unknown;
      readonly runtime: unknown;
      readonly candidate: unknown;
      readonly path: string;
      readonly prune: boolean;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    }
  | {
      readonly kind: "project-key";
      readonly slot: Record<string, unknown>;
      readonly source: Record<string, unknown>;
      readonly runtime: Record<string, unknown>;
      readonly candidate: Record<string, unknown>;
      readonly key: string;
      readonly path: string;
      readonly pruneChildren: boolean;
    }
  | {
      readonly kind: "project-exit";
      readonly source: Record<string, unknown>;
      readonly runtime: Record<string, unknown>;
      readonly candidate: Record<string, unknown>;
      readonly projected: Record<string, unknown>;
      readonly keys: readonly string[];
      readonly slots: readonly Record<string, unknown>[];
      readonly path: string;
      readonly pruneChildren: boolean;
      readonly changedByNonRecordRuntime: boolean;
      readonly container: Record<string, unknown> | unknown[];
      readonly key: string | number;
    };

const UNCHANGED = Symbol("unchanged config value");
const ABSENT = Symbol("absent config value");

function settleProjectionFrame(
  frame: Extract<ProjectionFrame, { kind: "enter" | "project-exit" }>,
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

/** Projects runtime edits onto source values; only missing keys represent deletion. */
export function projectRuntimeChangesOntoSource(
  sourceConfig: unknown,
  runtimeConfig: unknown,
  nextConfig: unknown,
  options: { pruneUnauthoredDeletions?: boolean } = {},
): unknown {
  const root: Record<string, unknown> = {};
  const pending: ProjectionFrame[] = [
    {
      kind: "enter",
      source: sourceConfig,
      runtime: runtimeConfig,
      candidate: nextConfig,
      path: "",
      prune: options.pruneUnauthoredDeletions === true,
      container: root,
      key: "projected",
    },
  ];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) {
      break;
    }
    if (frame.kind === "project-key") {
      const slot = frame.slot;
      if (!Object.hasOwn(frame.candidate, frame.key)) {
        slot.result = ABSENT;
        continue;
      }
      const sourceValue = Object.hasOwn(frame.source, frame.key)
        ? frame.source[frame.key]
        : undefined;
      pending.push({
        kind: "enter",
        source: sourceValue,
        runtime: Object.hasOwn(frame.runtime, frame.key) ? frame.runtime[frame.key] : ABSENT,
        candidate: frame.candidate[frame.key],
        path: formatConfigPatchPath(frame.path, frame.key),
        prune: frame.pruneChildren,
        container: slot,
        key: "result",
      });
      continue;
    }
    if (frame.kind === "project-exit") {
      let changed = frame.changedByNonRecordRuntime;
      for (const [index, key] of frame.keys.entries()) {
        const slot = frame.slots[index];
        if (slot === undefined) {
          continue;
        }
        const value = slot.result;
        const sourceValue = Object.hasOwn(frame.source, key) ? frame.source[key] : undefined;
        if (
          value === UNCHANGED ||
          (value === ABSENT && frame.pruneChildren && sourceValue === undefined)
        ) {
          continue;
        }
        changed = true;
        if (!isMergePatchObjectKeyAllowed(key, frame.path)) {
          continue;
        }
        if (value === ABSENT) {
          delete frame.projected[key];
        } else {
          frame.projected[key] = value;
        }
      }
      settleProjectionFrame(frame, changed ? frame.projected : UNCHANGED);
      continue;
    }
    if (deepEqualStackSafe(frame.runtime, frame.candidate)) {
      settleProjectionFrame(frame, UNCHANGED);
      continue;
    }
    if (!isRecord(frame.candidate)) {
      settleProjectionFrame(frame, cloneUnknown(frame.candidate));
      continue;
    }
    const sourceRecord = isRecord(frame.source) ? frame.source : {};
    const runtimeRecord = isRecord(frame.runtime) ? frame.runtime : {};
    const projected = cloneUnknown(sourceRecord);
    // Explicit empty objects and authored scalars own their replacement shape.
    const pruneChildren =
      frame.prune &&
      (frame.source === undefined || isRecord(frame.source)) &&
      Object.keys(frame.candidate).length > 0;
    const keys = [...new Set([...Object.keys(runtimeRecord), ...Object.keys(frame.candidate)])];
    const slots = keys.map((): Record<string, unknown> => ({}));
    pending.push({
      kind: "project-exit",
      source: sourceRecord,
      runtime: runtimeRecord,
      candidate: frame.candidate,
      projected,
      keys,
      slots,
      path: frame.path,
      pruneChildren,
      changedByNonRecordRuntime: !isRecord(frame.runtime),
      container: frame.container,
      key: frame.key,
    });
    // Pushed in reverse so keys project in document order.
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const slot = slots[index];
      const key = keys[index];
      if (slot === undefined || key === undefined) {
        continue;
      }
      pending.push({
        kind: "project-key",
        slot,
        source: sourceRecord,
        runtime: runtimeRecord,
        candidate: frame.candidate,
        key,
        path: frame.path,
        pruneChildren,
      });
    }
  }
  return root.projected === UNCHANGED ? cloneUnknown(sourceConfig) : root.projected;
}
