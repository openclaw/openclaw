import { expect } from "vitest";

export async function expectRejectCode(promise: Promise<unknown>, expected: string | RegExp) {
  const err = await promise.catch((caught: unknown) => caught);
  if (err === undefined) {
    throw new Error("Expected promise to reject");
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof expected === "string") {
    expect(code).toBe(expected);
  } else {
    expect(code).toMatch(expected);
  }
}
