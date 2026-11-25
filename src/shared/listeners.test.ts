import { expect, it } from "vitest";
import { createChangeListeners } from "./listeners.js";

it.each([
  { snapshot: undefined, expected: ["first", "added"] },
  { snapshot: true, expected: ["first", "removed"] },
])(
  "publishes each callback identity and supports clearing (snapshot=$snapshot)",
  ({ snapshot, expected }) => {
    const changes = createChangeListeners(snapshot === undefined ? undefined : { snapshot });
    const calls: string[] = [];
    const added = () => calls.push("added");
    const first = () => {
      calls.push("first");
      stopSecond();
      changes.subscribe(added);
    };
    const stopFirst = changes.subscribe(first);
    changes.subscribe(first);
    const stopSecond = changes.subscribe(() => calls.push("removed"));
    changes.publish();
    expect(calls).toEqual(expected);
    stopFirst();
    stopFirst();
    changes.clear();
    changes.subscribe(() => calls.push("after clear"));
    changes.publish();
    expect(calls).toEqual([...expected, "after clear"]);
  },
);

it.each([undefined, true])("propagates the first listener error (snapshot=%s)", (snapshot) => {
  const changes = createChangeListeners(snapshot === undefined ? undefined : { snapshot });
  const failure = new Error("listener failed");
  let delivered = false;
  changes.subscribe(() => {
    throw failure;
  });
  changes.subscribe(() => {
    delivered = true;
  });
  expect(() => changes.publish()).toThrow(failure);
  expect(delivered).toBe(false);
});
