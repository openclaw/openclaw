import { expect, vi } from "vitest";
import type { SourceProjection } from "./projection.ts";

/** Owner fixtures mutate through their public API; this checks only projection custody. */
export async function verifyApplicationProjection<S, T>(options: {
  create: () => { source: S; update: () => void | Promise<unknown>; dispose?: () => void };
  project: (source: S) => SourceProjection<S, T>;
  select: (snapshot: T) => unknown;
  initial: unknown;
  updated: unknown;
}) {
  const first = options.create();
  const second = options.create();
  const projection = options.project(first.source);
  const listener = vi.fn();
  try {
    expect(options.select(projection.read())).toEqual(options.initial);
    const stop = projection.subscribe(listener);
    await first.update();
    expect(options.select(projection.read())).toEqual(options.updated);
    expect(listener).toHaveBeenCalled();

    projection.replaceSource(second.source);
    expect(options.select(projection.read())).toEqual(options.initial);
    listener.mockClear();
    await first.update();
    expect(listener).not.toHaveBeenCalled();
    await second.update();
    expect(options.select(projection.read())).toEqual(options.updated);
    expect(listener).toHaveBeenCalled();

    stop();
    const revision = projection.revision();
    listener.mockClear();
    projection.dispose();
    await second.update();
    expect(listener).not.toHaveBeenCalled();
    expect(projection.revision()).toBe(revision);
  } finally {
    projection.dispose();
    first.dispose?.();
    second.dispose?.();
  }
}
