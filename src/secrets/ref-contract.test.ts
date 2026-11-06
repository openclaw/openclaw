/** Tests secret ref id validation, labels, and provider alias contracts. */
import { describe, expect, it } from "vitest";
import {
  INVALID_FILE_SECRET_REF_IDS,
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_FILE_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import {
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  isValidSecretRef,
  resolveDefaultSecretProviderAlias,
} from "./ref-contract.js";

describe.each([
  ["file", isValidFileSecretRefId, VALID_FILE_SECRET_REF_IDS, INVALID_FILE_SECRET_REF_IDS],
  ["exec", isValidExecSecretRefId, VALID_EXEC_SECRET_REF_IDS, INVALID_EXEC_SECRET_REF_IDS],
] as const)("%s secret ref id validation", (source, isValid, validIds, invalidIds) => {
  it(`accepts valid ${source} secret ref ids`, () => {
    for (const id of validIds) {
      expect(isValid(id), `expected valid id: ${id}`).toBe(true);
    }
  });

  it(`rejects invalid ${source} secret ref ids`, () => {
    for (const id of invalidIds) {
      expect(isValid(id), `expected invalid id: ${id}`).toBe(false);
    }
  });
});

describe("secret ref validation", () => {
  it("uses env-name grammar and source-specific defaults for store refs", () => {
    expect(isValidSecretRef({ source: "store", provider: "default", id: "STORED_API_KEY" })).toBe(
      true,
    );
    expect(isValidSecretRef({ source: "store", provider: "default", id: "lowercase" })).toBe(false);
    expect(
      resolveDefaultSecretProviderAlias({ secrets: { defaults: { store: "teamstore" } } }, "store"),
    ).toBe("teamstore");
  });
});
