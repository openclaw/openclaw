import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateCredentialStewardExposure,
  type CredentialStewardDecision,
} from "./credential-steward-policy.js";

type CredentialStewardFixture = {
  name: string;
  value?: unknown;
  labels?: string[];
  expected: CredentialStewardDecision;
  rawMustNotContain?: string[];
};

const fixtures = JSON.parse(
  readFileSync("test/fixtures/credential-steward-redaction-cases.json", "utf8"),
) as CredentialStewardFixture[];

describe("Credential Steward redaction policy", () => {
  it.each(fixtures)("classifies and redacts $name", (fixture) => {
    const decision = evaluateCredentialStewardExposure({
      value: fixture.value,
      labels: fixture.labels,
    });

    expect(decision).toEqual(fixture.expected);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
    }
  });

  it("allows explicit credential-material handling without exposing raw material", () => {
    const decision = evaluateCredentialStewardExposure({
      value: { token: "raw-token-value-123456" },
      allowCredentialMaterial: true,
    });

    expect(decision).toMatchObject({
      exposureKind: "credential_material",
      blocked: false,
      credentialClassesInvolved: ["token"],
      redactedSummary: "credential material redacted",
    });
    expect(JSON.stringify(decision)).not.toContain("raw-token-value-123456");
  });
});
