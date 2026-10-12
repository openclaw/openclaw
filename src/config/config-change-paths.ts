// Reports config paths whose values differ between two snapshots, walking the
// documents on an explicit work stack: document nesting costs heap rather than
// call frames, so a schema-valid deep config cannot crash the write path with
// a RangeError before the changed paths are known. Emission order matches a
// depth-first key walk so callers observe a stable path order.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";

type ChangedPathFrame =
  | {
      readonly kind: "walk";
      readonly base: unknown;
      readonly target: unknown;
      readonly path: string;
    }
  | { readonly kind: "emit"; readonly path: string };

export function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  const stack: ChangedPathFrame[] = [{ kind: "walk", base, target, path }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      break;
    }
    if (frame.kind === "emit") {
      output.add(frame.path);
      continue;
    }
    if (Object.is(frame.base, frame.target)) {
      continue;
    }
    if (Array.isArray(frame.base) && Array.isArray(frame.target)) {
      const max = Math.max(frame.base.length, frame.target.length);
      // Frames are pushed in reverse so the walk emits indices in order.
      for (let index = max - 1; index >= 0; index -= 1) {
        const childPath = frame.path ? `${frame.path}[${index}]` : `[${index}]`;
        if (index >= frame.base.length || index >= frame.target.length) {
          stack.push({ kind: "emit", path: childPath });
          continue;
        }
        stack.push({
          kind: "walk",
          base: frame.base[index],
          target: frame.target[index],
          path: childPath,
        });
      }
      continue;
    }
    if (isRecord(frame.base) && isRecord(frame.target)) {
      const keys = [...new Set([...Object.keys(frame.base), ...Object.keys(frame.target)])];
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        const childPath = frame.path ? `${frame.path}.${key}` : key;
        const hasBase = Object.hasOwn(frame.base, key);
        const hasTarget = Object.hasOwn(frame.target, key);
        if (!hasTarget || !hasBase) {
          stack.push({ kind: "emit", path: childPath });
          continue;
        }
        stack.push({
          kind: "walk",
          base: frame.base[key],
          target: frame.target[key],
          path: childPath,
        });
      }
      continue;
    }
    if (!isDeepStrictEqual(frame.base, frame.target)) {
      output.add(frame.path);
    }
  }
}
