import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches only with legacy host-header fallback", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
      allowHostHeaderOriginFallback: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects same-origin host matches when legacy host-header fallback is disabled", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://gateway.example.com:18789",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts loopback host mismatches for dev", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts allowlisted origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing origin", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects mismatched origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts object-form allowedOrigins entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [{ origin: "https://dash.example.com", tokenOnlyAuth: true }],
    });
    expect(result.ok).toBe(true);
  });

  it("returns matched info with tokenOnlyAuth for object entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [{ origin: "https://dash.example.com", tokenOnlyAuth: true }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched?.tokenOnlyAuth).toBe(true);
    }
  });

  it("returns matched info without tokenOnlyAuth for plain string entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched?.tokenOnlyAuth).toBe(false);
    }
  });

  it("does not return matched info for host-header fallback matches", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
      allowHostHeaderOriginFallback: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched).toBeUndefined();
    }
  });

  it("accepts mixed string and object allowedOrigins", () => {
    const result1 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.matched?.tokenOnlyAuth).toBe(false);
    }

    const result2 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.matched?.tokenOnlyAuth).toBe(true);
    }
  });

  it("rejects origins not in mixed allowlist", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("accepts object-form allowedOrigins entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [{ origin: "https://dash.example.com", tokenOnlyAuth: true }],
    });
    expect(result.ok).toBe(true);
  });

  it("returns matched info with tokenOnlyAuth for object entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [{ origin: "https://dash.example.com", tokenOnlyAuth: true }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched?.tokenOnlyAuth).toBe(true);
    }
  });

  it("returns matched info without tokenOnlyAuth for plain string entries", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched?.tokenOnlyAuth).toBe(false);
    }
  });

  it("does not return matched info for host-header fallback matches", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
      allowHostHeaderOriginFallback: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matched).toBeUndefined();
    }
  });

  it("accepts mixed string and object allowedOrigins", () => {
    const result1 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.matched?.tokenOnlyAuth).toBe(false);
    }

    const result2 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://dash.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.matched?.tokenOnlyAuth).toBe(true);
    }
  });

  it("rejects origins not in mixed allowlist", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
      allowedOrigins: [
        "https://control.example.com",
        { origin: "https://dash.example.com", tokenOnlyAuth: true },
      ],
    });
    expect(result.ok).toBe(false);
  });
});
