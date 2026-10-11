import { describe, expect, it } from "vitest";
import { findTruncatedSecret } from "./redact-open-secret.js";
import { redactSensitiveText } from "./redact.js";

// Built at runtime so the fixtures are not literal credentials.
const BODY = "A1b2C3d4".repeat(4);
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

describe("findTruncatedSecret", () => {
  it.each([
    { name: "Atlassian token before its = suffix", lead: "key ", secret: `ATATT${BODY}` },
    { name: "Atlassian token in lower case", lead: "key ", secret: `atctt3xffg${BODY}` },
    { name: "JWT before its signature", lead: "Bearer ", secret: `${JWT_HEADER}.${BODY}` },
    { name: "JWT in upper case", lead: "Bearer ", secret: `EYJ${JWT_HEADER.slice(3)}.${BODY}` },
    { name: "web URL password before its @", lead: "https://deploy:", secret: BODY },
    { name: "database URL path before its @", lead: "postgres://db.test:", secret: `5432/${BODY}` },
    { name: "form value before its next pair", lead: "body code=", secret: BODY },
    {
      name: "private key before its END line",
      lead: "key\n",
      secret: `-----BEGIN PRIVATE KEY-----\n${BODY}`,
    },
  ])("finds the $name", ({ lead, secret }) => {
    expect(findTruncatedSecret(`${lead}${secret}`)).toEqual({ start: lead.length, closing: "" });
  });

  it.each([
    { name: "JSON secret", lead: 'config {"password": "' },
    // The form rule takes the quote as the value's first character; the quoted rule closes it.
    { name: "quoted form value", lead: 'body api_key="' },
  ])("returns the closing quote of an open $name", ({ lead }) => {
    expect(findTruncatedSecret(`${lead}${BODY}`)).toEqual({ start: lead.length, closing: '"' });
  });

  it.each([
    { name: "a complete URL password", text: `https://deploy:${BODY}@host.test/path` },
    { name: "a web URL port before its path", text: `https://host.test:8443/${BODY}` },
    { name: "a dot-free base64url run after eyJ", text: `json ${JWT_HEADER}${BODY}` },
    { name: "a token prefix inside a word", text: `xATATT${BODY}` },
    { name: "a token prefix in a data URL", text: `data:image/png;base64,${BODY}/ATATT${BODY}` },
    { name: "a form value of a key no rule masks", text: `body page=${BODY}` },
    {
      name: "a closed private key",
      text: `-----BEGIN PRIVATE KEY-----\n${BODY}\n-----END PRIVATE KEY-----\ntext`,
    },
  ])("finds nothing in $name", ({ text }) => {
    expect(findTruncatedSecret(text)).toBeUndefined();
  });

  it("finds the open token the redactor masks once the text closes it", () => {
    // The cut leaves the rule unmatched; the closed text masks from the reported start.
    const text = `key ATATT${BODY}`;
    const closed = `${text}=${BODY.slice(0, 8)}`;

    expect(redactSensitiveText(text)).toContain(BODY);
    expect(redactSensitiveText(closed)).not.toContain(BODY);
    expect(findTruncatedSecret(text)?.start).toBe("key ".length);
  });
});
