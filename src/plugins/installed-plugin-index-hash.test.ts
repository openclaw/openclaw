import { expect, it } from "vitest";
import { hashStableJson } from "./installed-plugin-index-hash.js";

it("distinguishes native plugin fingerprint values from each other and JSON values", () => {
  const values = [
    {},
    null,
    "2026-01-01T00:00:00.000Z",
    "/alpha/gi",
    [],
    ["alpha"],
    [["key", "alpha"]],
    new Date("2026-01-01T00:00:00.000Z"),
    new Date("2026-01-02T00:00:00.000Z"),
    new Date(Number.NaN),
    /alpha/gi,
    /beta/gi,
    /alpha/g,
    new Set(),
    new Set(["alpha"]),
    new Set(["beta"]),
    new Map(),
    new Map([["key", "alpha"]]),
    new Map([["key", "beta"]]),
    new Map([[1, "value"]]),
    new Map([["1", "value"]]),
  ];
  const fingerprints = values.map((proofValue) =>
    hashStableJson({ id: "proof-agent", proofValue }),
  );
  expect(new Set(fingerprints).size).toBe(values.length);
  expect(hashStableJson({ proofValue: new Set(["alpha", "beta"]) })).toBe(
    hashStableJson({ proofValue: new Set(["beta", "alpha"]) }),
  );
  expect(
    hashStableJson({
      proofValue: new Map([
        ["a", 1],
        ["b", 2],
      ]),
    }),
  ).toBe(
    hashStableJson({
      proofValue: new Map([
        ["b", 2],
        ["a", 1],
      ]),
    }),
  );
});
