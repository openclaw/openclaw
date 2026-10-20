import { expect, it } from "vitest";
import { createChangeListeners } from "./listeners.js";

it("publishes live subscriptions once per callback identity and supports clearing", () => {
  const changes = createChangeListeners();
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
  expect(calls).toEqual(["first", "added"]);
  stopFirst();
  stopFirst();
  changes.clear();
  changes.subscribe(() => calls.push("after clear"));
  changes.publish();
  expect(calls).toEqual(["first", "added", "after clear"]);
});

it("propagates the first listener error without delivering later listeners", () => {
  const changes = createChangeListeners();
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
