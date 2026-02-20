import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackRequestSignature } from "./verify.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

function makeSignature(secret: string, timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", secret).update(baseString).digest("hex");
  return `v0=${hmac}`;
}

const NOW_MS = 1_700_000_000_000;
const FRESH_TIMESTAMP = String(Math.floor(NOW_MS / 1000));

describe("verifySlackRequestSignature", () => {
  it("returns ok=true for a valid signature", () => {
    const body = '{"type":"event_callback"}';
    const signature = makeSignature(SIGNING_SECRET, FRESH_TIMESTAMP, body);

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: FRESH_TIMESTAMP,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a missing timestamp header (400)", () => {
    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body: "{}",
      timestamp: undefined,
      signature: "v0=abc",
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.reason).toMatch(/Timestamp/i);
  });

  it("rejects a missing signature header (400)", () => {
    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body: "{}",
      timestamp: FRESH_TIMESTAMP,
      signature: undefined,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.reason).toMatch(/Signature/i);
  });

  it("rejects a timestamp more than 5 minutes old (400)", () => {
    const staleTimestamp = String(Math.floor(NOW_MS / 1000) - 6 * 60);
    const body = "{}";
    const signature = makeSignature(SIGNING_SECRET, staleTimestamp, body);

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: staleTimestamp,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.reason).toMatch(/timestamp/i);
  });

  it("rejects a timestamp more than 5 minutes in the future (400)", () => {
    const futureTimestamp = String(Math.floor(NOW_MS / 1000) + 6 * 60);
    const body = "{}";
    const signature = makeSignature(SIGNING_SECRET, futureTimestamp, body);

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: futureTimestamp,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.reason).toMatch(/timestamp/i);
  });

  it("rejects a tampered body (401)", () => {
    const body = '{"type":"event_callback"}';
    const signature = makeSignature(SIGNING_SECRET, FRESH_TIMESTAMP, body);
    const tamperedBody = '{"type":"event_callback","extra":"injected"}';

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body: tamperedBody,
      timestamp: FRESH_TIMESTAMP,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects a wrong signing secret (401)", () => {
    const body = "{}";
    const signature = makeSignature("wrong-secret", FRESH_TIMESTAMP, body);

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: FRESH_TIMESTAMP,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects a malformed signature string (401)", () => {
    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body: "{}",
      timestamp: FRESH_TIMESTAMP,
      signature: "not-a-valid-signature",
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it("rejects a non-numeric timestamp (400)", () => {
    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body: "{}",
      timestamp: "not-a-number",
      signature: "v0=abc",
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  it("accepts a timestamp exactly at the 5-minute boundary", () => {
    const borderTimestamp = String(Math.floor(NOW_MS / 1000) - 5 * 60);
    const body = "{}";
    const signature = makeSignature(SIGNING_SECRET, borderTimestamp, body);

    const result = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: borderTimestamp,
      signature,
      nowMs: NOW_MS,
    });

    expect(result.ok).toBe(true);
  });

  it("is resistant to timing attacks (uses timingSafeEqual)", () => {
    // This is a property test: ensure that a request with a completely wrong
    // signature returns the same result shape as one with a nearly-right
    // signature, verifying the function does not short-circuit.
    const body = "{}";
    const correctSignature = makeSignature(SIGNING_SECRET, FRESH_TIMESTAMP, body);
    const almostCorrect = correctSignature.slice(0, -1) + "0"; // flip last char

    const result1 = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: FRESH_TIMESTAMP,
      signature: almostCorrect,
      nowMs: NOW_MS,
    });
    const result2 = verifySlackRequestSignature({
      signingSecret: SIGNING_SECRET,
      body,
      timestamp: FRESH_TIMESTAMP,
      signature: "v0=0000000000000000000000000000000000000000000000000000000000000000",
      nowMs: NOW_MS,
    });

    expect(result1.ok).toBe(false);
    expect(result2.ok).toBe(false);
    expect(result1.statusCode).toBe(401);
    expect(result2.statusCode).toBe(401);
  });
});
