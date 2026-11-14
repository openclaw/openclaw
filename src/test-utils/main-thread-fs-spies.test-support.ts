import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** Observe exported synchronous filesystem calls without changing their native properties. */
export function observeMainThreadFs() {
  const originals = Object.getOwnPropertyDescriptors(fs);
  const calls = new Map<string, number>();
  let count = 0;
  const stacks = new Map<string, { api: string; stack: string; calls: number }>();
  function record(api: string) {
    count++;
    calls.set(api, (calls.get(api) ?? 0) + 1);
    const stack = (new Error().stack ?? "").split("\n").slice(3).join("\n");
    const key = `${api}\n${stack}`;
    const entry = stacks.get(key);
    if (entry) {
      entry.calls++;
    } else {
      stacks.set(key, { api, stack, calls: 1 });
    }
  }
  for (const [name, original] of Object.entries(fs)) {
    if (!name.endsWith("Sync") || typeof original !== "function") {
      continue;
    }
    const measured = (...args: unknown[]) => {
      record(name);
      return Reflect.apply(original, fs, args);
    };
    Object.defineProperties(measured, Object.getOwnPropertyDescriptors(original));
    Object.defineProperty(fs, name, { ...originals[name], value: measured });
  }
  const native = fs.realpathSync.native;
  Object.defineProperty(fs.realpathSync, "native", {
    ...Object.getOwnPropertyDescriptor(fs.realpathSync, "native"),
    value: (...args: Parameters<typeof native>) => {
      record("realpathSync.native");
      return Reflect.apply(native, fs.realpathSync, args);
    },
  });
  syncBuiltinESMExports();
  return {
    count: () => count,
    stacks: () => [...stacks.values()],
    calls: () => Object.fromEntries(calls),
    [Symbol.dispose]() {
      Object.defineProperties(fs, originals);
      syncBuiltinESMExports();
    },
  };
}
