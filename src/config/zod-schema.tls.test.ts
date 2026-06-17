// Schema-level tests for gateway.tls certPath and keyPath validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("gateway.tls schema", () => {
  it("rejects empty certPath", () => {
    const res = validateConfigObject({ gateway: { tls: { enabled: true, certPath: "" } } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toMatch(/certPath/);
    }
  });

  it("rejects whitespace-only keyPath", () => {
    const res = validateConfigObject({ gateway: { tls: { enabled: true, keyPath: "   " } } });
    expect(res.ok).toBe(false);
  });

  it("accepts a non-empty certPath", () => {
    const res = validateConfigObject({
      gateway: { tls: { enabled: true, certPath: "/etc/ssl/cert.pem" } },
    });
    expect(res.ok).toBe(true);
  });

  it("trims whitespace from a valid certPath", () => {
    const res = validateConfigObject({
      gateway: { tls: { enabled: true, certPath: "  /etc/ssl/cert.pem  " } },
    });
    expect(res.ok).toBe(true);
  });
});
