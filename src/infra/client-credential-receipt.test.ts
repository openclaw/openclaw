import { expect, it } from "vitest";
import {
  emptyClientCredentialReceipt,
  parseClientCredentialReceipt,
  serializeClientCredentialReceipt,
} from "./client-credential-receipt.js";

const receipt = () => ({
  ...emptyClientCredentialReceipt({
    path: "/fixture/state/openclaw.sqlite",
    dev: "102",
    ino: "42",
  }),
  legacyImports: { "identity:primary": { sha256: "a".repeat(64) } },
});

it.each([
  { dev: "102", ino: "-1080579411880673137" },
  { dev: "-1080579411880673137", ino: "42" },
  { dev: "102", ino: "18446744073709551615" },
])(
  "round trips native filesystem identity strings without changing bindings or claims (%j)",
  (identity) => {
    const value = receipt();
    Object.assign(value.sharedFile!, identity);
    expect(parseClientCredentialReceipt(serializeClientCredentialReceipt(value))).toEqual(value);
  },
);

it.each(["-1.0", "-1e3", "+1", "--1", ""])("refuses malformed identity %j", (ino) => {
  const value = receipt();
  value.sharedFile!.ino = ino;
  expect(() => parseClientCredentialReceipt(JSON.stringify(value))).toThrow("receipt is invalid");
});

it.each([
  { format: 2 },
  { source: { kind: "unknown", engine: "postgres" } },
  { legacyImports: { unknown: { sha256: null } } },
])("still refuses unsupported receipt data (%j)", (change) => {
  expect(() => parseClientCredentialReceipt(JSON.stringify({ ...receipt(), ...change }))).toThrow(
    "receipt is invalid",
  );
});
