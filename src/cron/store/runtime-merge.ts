import { isDeepStrictEqual } from "node:util";
import type { CronJob } from "../types.js";

function fieldsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  key: string,
): boolean {
  return (
    Object.hasOwn(left, key) === Object.hasOwn(right, key) &&
    isDeepStrictEqual(left[key], right[key])
  );
}

function copyField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  if (Object.hasOwn(source, key)) {
    target[key] = structuredClone(source[key]);
  } else {
    delete target[key];
  }
}

/** Three-way merges runtime state so disjoint caller and concurrent fields both survive. */
export function mergeCronRuntimeStateFields(params: {
  current: CronJob["state"];
  next: CronJob["state"];
  expected: CronJob["state"];
}): CronJob["state"] | undefined {
  const expected = (params.expected ?? {}) as Record<string, unknown>;
  const current = (params.current ?? {}) as Record<string, unknown>;
  const next = (params.next ?? {}) as Record<string, unknown>;
  const merged = structuredClone(next);
  for (const key of new Set([
    ...Object.keys(expected),
    ...Object.keys(current),
    ...Object.keys(next),
  ])) {
    const currentChanged = !fieldsEqual(current, expected, key);
    const nextChanged = !fieldsEqual(next, expected, key);
    if (currentChanged && nextChanged && !fieldsEqual(current, next, key)) {
      return undefined;
    }
    if (currentChanged && !nextChanged) {
      copyField(merged, current, key);
    }
  }
  return merged;
}

/** Three-way merges runtime fields; undefined means both writers changed one field differently. */
export function preserveConcurrentCronRuntime(params: {
  current: CronJob | undefined;
  next: CronJob;
  expectedRuntimeState: CronJob["state"];
  expectedRuntimeUpdatedAtMs: number;
}): CronJob | undefined {
  if (!params.current || params.current.id !== params.next.id) {
    return params.next;
  }
  const merged = mergeCronRuntimeStateFields({
    current: params.current.state ?? {},
    next: params.next.state ?? {},
    expected: params.expectedRuntimeState ?? {},
  });
  if (!merged) {
    return undefined;
  }
  return {
    ...params.next,
    updatedAtMs: Math.max(params.next.updatedAtMs, params.current.updatedAtMs),
    state: merged,
  };
}
