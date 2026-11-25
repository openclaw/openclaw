import { expect, it } from "vitest";
import { normalizeLowercaseStringSet } from "./normalized-string-set.js";

it("normalizes iterable strings without coercing malformed entries, preserving first-seen order", () => {
  function* values() {
    yield " WRITE ";
    yield 123;
    yield false;
    yield {
      toString: () => {
        throw new Error("must not coerce");
      },
    };
    yield null;
    yield undefined;
    yield "";
    yield "  ";
    yield "read";
    yield "write";
  }
  expect([...normalizeLowercaseStringSet(values())]).toEqual(["write", "read"]);
});
