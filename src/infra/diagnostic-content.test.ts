import { expect, it } from "vitest";
import { joinDiagnosticContent, truncateDiagnosticContent } from "./diagnostic-content.js";

// Mirrors the private per-field budget in diagnostic-content.ts; the production
// constant stays unexported because only tests would consume it.
const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;

it("joins captured parts on newlines and drops empty ones", () => {
  expect(joinDiagnosticContent(["first answer", "", "second answer"])).toBe(
    "first answer\nsecond answer",
  );
});

it("returns undefined when no part carries content", () => {
  expect(joinDiagnosticContent([])).toBeUndefined();
  expect(joinDiagnosticContent(["", ""])).toBeUndefined();
});

it("bounds the joined content to the diagnostic budget and marks truncation", () => {
  const oversized = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
  const joined = joinDiagnosticContent([oversized, "dropped tail"], "…[truncated]");
  expect(joined).toBeDefined();
  expect(joined?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
  expect(joined?.endsWith("…[truncated]")).toBe(true);
});

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
  const truncated = truncateDiagnosticContent(`${"x".repeat(100)}${pem}${"y".repeat(200)}`);
  expect(truncated.includes("MIIEowIBAAKCAQEAwibble")).toBe(false);
});

it("redacts each joined part before bounding", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAwibble\n-----END RSA PRIVATE KEY-----";
  const joined = joinDiagnosticContent([pem]);
  expect(joined?.includes("MIIEowIBAAKCAQEAwibble")).toBe(false);
});

it("redacts secrets spanning multiple streamed parts", () => {
  // Streamed chunks can split a secret block across parts; the join must
  // redact against the complete logical content, not per-part.
  const joined = joinDiagnosticContent([
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAwibble",
    "-----END RSA PRIVATE KEY-----",
  ]);
  expect(joined?.includes("MIIEowIBAAKCAQEAwibble")).toBe(false);
  // The host redactor replaces the PEM body with an ellipsis marker; the
  // BEGIN/END marker lines remain (they contain no secret material).
  expect(joined?.includes("…redacted…")).toBe(true);
});

it("keeps later answer parts when an earlier part shrinks under redaction", () => {
  // Redaction shortening an earlier part is not truncation; the remaining
  // parts must still be captured.
  const joined = joinDiagnosticContent([
    "password=example-secret-value",
    "The task completed successfully",
  ]);
  expect(joined?.includes("example-secret-value")).toBe(false);
  expect(joined?.includes("The task completed successfully")).toBe(true);
});
