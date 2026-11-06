import { createEffect, createRoot, flush } from "solid-js";
import { expect } from "vitest";
import type { SourceProjection } from "./projection.ts";

/** Owner fixtures mutate through their public API; this checks only projection custody. */
export async function verifyApplicationProjection<S, T>(options: {
  create: () => { source: S; update: () => void | Promise<unknown>; dispose?: () => void };
  project: (source: S) => Pick<SourceProjection<S, T>, "read" | "revision">;
  select: (snapshot: T) => unknown;
  initial: unknown;
  updated: unknown;
}) {
  const first = options.create();
  const second = options.create();
  const projection = options.project(first.source);
  const other = options.project(second.source);
  const values: unknown[] = [];
  const otherValues: unknown[] = [];
  const stop = createRoot((dispose) => {
    createEffect(
      () => options.select(projection.read()),
      (value) => {
        values.push(value);
      },
    );
    return dispose;
  });
  const stopOther = createRoot((dispose) => {
    createEffect(
      () => options.select(other.read()),
      (value) => {
        otherValues.push(value);
      },
    );
    return dispose;
  });
  flush();
  try {
    expect(options.select(projection.read())).toEqual(options.initial);
    await first.update();
    flush();
    expect(options.select(projection.read())).toEqual(options.updated);
    expect(values.at(-1)).toEqual(options.updated);
    expect(options.select(other.read())).toEqual(options.initial);
    expect(otherValues).toEqual([options.initial]);

    stop();
    const revision = projection.revision();
    const count = values.length;
    await first.update();
    flush();
    expect(values).toHaveLength(count);
    expect(projection.revision()).toBe(revision);
    await second.update();
    flush();
    expect(options.select(other.read())).toEqual(options.updated);
    expect(otherValues.at(-1)).toEqual(options.updated);
    stopOther();
    const otherCount = otherValues.length;
    await second.update();
    flush();
    expect(otherValues).toHaveLength(otherCount);
    expect(values).toHaveLength(count);
  } finally {
    stop();
    stopOther();
    first.dispose?.();
    second.dispose?.();
  }
}
