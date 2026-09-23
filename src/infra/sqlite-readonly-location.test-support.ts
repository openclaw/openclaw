import fs from "node:fs";
import { isPathInside } from "@openclaw/fs-safe/path";
import { expect, vi } from "vitest";

/** Observe snapshot/source writes without intercepting the runner's resource receipts. */
export function observeSnapshotWrites(
  roots: string[],
  beforeWrite?: (target: string, data: unknown) => void,
) {
  const descriptors = new Map<number, string>();
  const writes: Array<string | undefined> = [];
  const open = fs.openSync;
  const close = fs.closeSync;
  const write = fs.writeSync;
  vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const descriptor = open(...args);
    descriptors.set(descriptor, String(args[0]));
    return descriptor;
  });
  vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
    close(descriptor);
    descriptors.delete(descriptor);
  });
  vi.spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof write>) => {
    const target = descriptors.get(args[0]);
    // Keep unknown descriptors visible; never assume an unobserved write is harmless.
    if (target === undefined || roots.some((root) => isPathInside(root, target))) {
      writes.push(target);
      if (target !== undefined) {
        beforeWrite?.(target, args[1]);
      }
    }
    return write(...args);
  }) as typeof write);
  return writes;
}

/** Dispose the real staging owner even when an assertion before explicit cleanup fails. */
export function ownSnapshot<T extends { cleanup: () => boolean }>(prepared: T) {
  return Object.assign(prepared, {
    [Symbol.dispose]() {
      expect(prepared.cleanup()).toBe(true);
    },
  });
}
