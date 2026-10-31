import { expect, it } from "vitest";
import { truncateDiagnosticContent } from "./diagnostic-content.js";

// Mirrors the private per-field budget in diagnostic-content.ts; the production
// constant stays unexported because only tests would consume it.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

it("never splits a surrogate pair when truncating a single field", () => {
  const oversized = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const truncated = truncateDiagnosticContent(oversized);
  expect(truncated.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
  // A trailing high surrogate would mean the emoji was cut in half.
  expect(truncated.charCodeAt(truncated.length - 1)).not.toBe(0xd83d);
});

it("redacts secret material before bounding so truncation cannot split it", () => {
  // Redaction must see the complete block: truncating first could split a
  // PEM-style key so the redactor no longer recognizes it.
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwibble\n-----END RSA PRIVATE KEY-----";
  const truncated = truncateDiagnosticContent(
    `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 64)}${pem}${"y".repeat(200)}`,
  );
  expect(truncated.includes("MIIEowIBAAKCAQEAwibble")).toBe(false);
  expect(truncated.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
});
