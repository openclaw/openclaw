import { onCleanup, onSettled, runWithOwner } from "solid-js";
import type { SolidBridgeElement } from "../lib/solid-bridge.ts";

/** Observe native and Solid-owned property writes before their batched DOM commit. */
export function observeSolidBridgeProperties<P extends object>(
  host: SolidBridgeElement<P>,
  keys: (keyof P)[],
  changed?: (key: keyof P, before: unknown, after: unknown) => void,
  settled?: () => void,
) {
  let active = true;
  let queued = false;
  const schedule = () => {
    if (!active || !settled || queued) {
      return;
    }
    queued = true;
    // Foreign mount notifications may run under a root this update retires.
    runWithOwner(null, () => {
      onSettled(() => {
        queued = false;
        if (active) {
          settled();
        }
      });
    });
  };
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(host, key)] as const);
  for (const [key, descriptor] of descriptors) {
    if (!descriptor?.get || !descriptor.set) {
      throw new Error(`Missing bridge host property: ${String(key)}`);
    }
    Object.defineProperty(host, key, {
      ...descriptor,
      set(value: unknown) {
        const before: unknown = descriptor.get?.call(host);
        descriptor.set?.call(host, value);
        if (!Object.is(before, value)) {
          changed?.(key, before, value);
          schedule();
        }
      },
    });
  }
  onCleanup(() => {
    active = false;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(host, key, descriptor);
      }
    }
  });
  schedule();
  return schedule;
}
