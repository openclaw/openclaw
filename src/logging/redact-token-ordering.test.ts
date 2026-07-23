// Redaction ordering tests cover generic credential patterns around whole-token redaction.
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

function fakeJwtCredentialShapedSegment(): string {
  return Array.from({ length: 40 }, (_entry, index) => "Ab9C"[index % 4] ?? "A").join("");
}

function fakeAwsCredentialWithPadding(): string {
  return Array.from({ length: 40 }, (_entry, index) => "Ab9="[index % 4] ?? "A").join("");
}

function fakeCommitHash(): string {
  return `${"0123456789abcdef".repeat(2)}01234567`;
}

function fakeLowercaseBase36Identifier(): string {
  return `${"z".repeat(39)}1`;
}

describe("redactSensitiveText token ordering", () => {
  it("masks AWS secret access keys containing padding characters", () => {
    const secret = fakeAwsCredentialWithPadding();
    const output = redactSensitiveText(`aws_secret_access_key = ${secret}\nbare ${secret}`, {
      mode: "tools",
    });

    expect(output).not.toContain(secret);
    expect(output).toContain("aws_secret_access_key = ");
    expect(output).toContain("bare ");
  });

  it("masks a full JWT before generic bare credential matching", () => {
    const jwtSegment = fakeJwtCredentialShapedSegment();
    const jwt = `eyJheaderabcd.${jwtSegment}.signatureabcd123456`;
    const output = redactSensitiveText(`jwt ${jwt}`, { mode: "tools" });

    expect(output).not.toContain(jwtSegment);
    expect(output).not.toContain("signatureabcd123456");
    expect(output).toBe("jwt eyJhea…3456");
  });

  it("does not mask ordinary 40-character hex identifiers", () => {
    const commitHash = fakeCommitHash();
    expect(redactSensitiveText(`commit ${commitHash}`, { mode: "tools" })).toBe(
      `commit ${commitHash}`,
    );
  });

  it("does not mask ordinary lowercase 40-character alphanumeric identifiers", () => {
    const identifier = fakeLowercaseBase36Identifier();
    expect(redactSensitiveText(`id ${identifier}`, { mode: "tools" })).toBe(`id ${identifier}`);
  });
});
