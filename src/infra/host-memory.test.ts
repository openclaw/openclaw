import { afterEach, expect, it, vi } from "vitest";
import { isConstrainedProcessLowOnMemory } from "./host-memory.js";

afterEach(() => vi.restoreAllMocks());
it.each([
  [0, 0, false],
  [Number.MAX_VALUE, 0, false],
  [Number.NaN, 0, false],
  [1_000, 200, true],
  [1_000, 201, false],
])("classifies constrained headroom %s/%s as %s", (limit, available, expected) => {
  vi.spyOn(process, "constrainedMemory").mockReturnValue(limit);
  vi.spyOn(process, "availableMemory").mockReturnValue(available);
  expect(isConstrainedProcessLowOnMemory()).toBe(expected);
});
