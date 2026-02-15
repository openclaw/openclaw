import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateMessengerSignature } from "./signature.js";

const sign = (body: string, secret: string) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("validateMessengerSignature", () => {
  it("accepts valid signatures", () => {
    const secret = "test-app-secret";
    const rawBody = JSON.stringify({ object: "page", entry: [] });

    expect(validateMessengerSignature(rawBody, sign(rawBody, secret), secret)).toBe(true);
  });

  it("rejects signatures computed with the wrong secret", () => {
    const rawBody = JSON.stringify({ object: "page", entry: [] });

    expect(validateMessengerSignature(rawBody, sign(rawBody, "wrong-secret"), "secret")).toBe(
      false,
    );
  });

  it("rejects signatures with a different length", () => {
    const rawBody = JSON.stringify({ object: "page", entry: [] });

    expect(validateMessengerSignature(rawBody, "sha256=short", "secret")).toBe(false);
  });

  it("rejects signatures without the sha256= prefix", () => {
    const secret = "test-app-secret";
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const hash = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(validateMessengerSignature(rawBody, hash, secret)).toBe(false);
  });
});
