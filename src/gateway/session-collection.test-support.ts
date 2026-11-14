import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect } from "vitest";

export const weak = (value: object) => new WeakRef(value);
export const weakControl = () => new WeakRef({});
export async function expectCollected(...refs: WeakRef<object>[]) {
  // End the WeakRef creation job; dereferencing before GC would keep targets alive.
  await nextTurn();
  queryObjects(WeakRef);
  refs.forEach((ref) => expect(ref.deref()).toBeUndefined());
}
