import { describe, expect, it } from "vitest";
import { checkBrowserOrigin, shouldCheckBrowserOrigin } from "./origin-check.js";
import { GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
    });
    expect(result.ok).toBe(true);
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
});

describe("shouldCheckBrowserOrigin", () => {
  it("does not enforce origin checks for non-browser clients without Origin", () => {
    const result = shouldCheckBrowserOrigin({
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    expect(result).toBe(false);
  });

  it("enforces origin checks when Origin header is present for non-browser clients", () => {
    const result = shouldCheckBrowserOrigin({
      requestOrigin: "https://app.example.com",
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    expect(result).toBe(true);
  });

  it("enforces origin checks when Origin is null for non-browser clients", () => {
    const result = shouldCheckBrowserOrigin({
      requestOrigin: "null",
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    expect(result).toBe(true);
  });

  it("enforces origin checks for UI mode without Origin", () => {
    const result = shouldCheckBrowserOrigin({
      clientMode: GATEWAY_CLIENT_MODES.UI,
    });
    expect(result).toBe(true);
  });
});
