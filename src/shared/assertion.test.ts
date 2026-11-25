import { expect, it } from "vitest";
import { assertionSucceeds } from "./assertion.js";

it("runs the current synchronous assertion once per check, regardless of its return value", () => {
  let calls = 0;
  let failure: Error | undefined;
  const assert = () => {
    calls++;
    if (failure !== undefined) {
      throw failure;
    }
    return false;
  };
  expect(assertionSucceeds(assert)).toBe(true);
  expect(calls).toBe(1);
  failure = new Error("revoked");
  expect(assertionSucceeds(assert)).toBe(false);
  expect(calls).toBe(2);
  failure = undefined;
  expect(assertionSucceeds(assert)).toBe(true);
  expect(calls).toBe(3);
  expect(assertionSucceeds(() => {})).toBe(true);
});
