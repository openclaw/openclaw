import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "./account-id.js";

describe("account id normalization", () => {
  const reservedAccountIdCases = [
    { name: "rejects __proto__ pollution keys", input: "__proto__" },
    { name: "rejects constructor pollution keys", input: "constructor" },
    { name: "rejects prototype pollution keys", input: "prototype" },
  ] as const;

  it.each([
    {
      name: "defaults undefined to default account",
      input: undefined,
      expected: DEFAULT_ACCOUNT_ID,
    },
    {
      name: "defaults blank strings to default account",
      input: "   ",
      expected: DEFAULT_ACCOUNT_ID,
    },
    { name: "normalizes valid ids to lowercase", input: "  Business_1  ", expected: "business_1" },
    {
      name: "sanitizes invalid characters into canonical ids",
      input: " Prod/US East ",
      expected: "prod-us-east",
    },
    ...reservedAccountIdCases.map(({ name, input }) => ({
      name,
      input,
      expected: DEFAULT_ACCOUNT_ID,
    })),
  ] as const)("$name", ({ input, expected }) => {
    expect(normalizeAccountId(input)).toBe(expected);
  });

  it.each([
    { name: "keeps undefined optional values unset", input: undefined, expected: undefined },
    { name: "keeps blank optional values unset", input: "   ", expected: undefined },
    { name: "keeps invalid optional values unset", input: " !!! ", expected: undefined },
    { name: "keeps reserved optional values unset", input: "__proto__", expected: undefined },
    { name: "normalizes valid optional values", input: "  Business  ", expected: "business" },
  ] as const)("$name", ({ input, expected }) => {
    expect(normalizeOptionalAccountId(input)).toBe(expected);
  });
});
