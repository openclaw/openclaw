import { expect, it } from "vitest";
import {
  createSqliteCommitReceipt,
  readSqliteCommitReceipt,
  type SqliteCommittedFact,
} from "./sqlite-commit-receipt.js";

const source = { identity: "fixture-database", incarnation: "fixture-connection" };
const receipt = () =>
  createSqliteCommitReceipt({
    source,
    domain: "fixture",
    keys: ["row"],
    readFact: () => ({ kind: "postimage", value: "committed" }),
  });
const expected = {
  domain: "fixture",
  source,
  keys: ["row"],
  isFact: (_key: string, fact: SqliteCommittedFact<unknown>) =>
    fact.kind === "postimage" && typeof fact.value === "string",
};

it("accepts a complete domain receipt without copying its committed facts", () => {
  const value = receipt();
  expect(readSqliteCommitReceipt<string>(value, expected)).toBe(value);
});

it.each([
  { source: { ...source, identity: "another-database" } },
  { source: { ...source, incarnation: "another-connection" } },
  { domain: "another-domain" },
  { facts: new Map() },
  { facts: new Map([["another-row", { kind: "postimage", value: "committed" }]]) },
  { facts: new Map([["row", { kind: "postimage", value: 123 }]]) },
  { facts: new Map([["row", null]]) },
  { version: 2 },
  { operationId: "" },
])("rejects a receipt outside its exact source, coverage, or domain contract: %j", (patch) => {
  expect(() => readSqliteCommitReceipt({ ...receipt(), ...patch }, expected)).toThrow(
    "State domain commit receipt is invalid",
  );
});
