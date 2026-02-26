import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe('dmPolicy="allowlist" requires non-empty allowFrom', () => {
  it('rejects telegram dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "allowlist", botToken: "fake" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('rejects telegram dmPolicy="allowlist" with empty allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "allowlist", allowFrom: [], botToken: "fake" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('accepts telegram dmPolicy="allowlist" with allowFrom entries', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "allowlist", allowFrom: ["12345"], botToken: "fake" } },
    });
    expect(res.ok).toBe(true);
  });

  it('accepts telegram dmPolicy="pairing" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "pairing", botToken: "fake" } },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects signal dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { signal: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('accepts signal dmPolicy="allowlist" with allowFrom entries', () => {
    const res = validateConfigObject({
      channels: { signal: { dmPolicy: "allowlist", allowFrom: ["+1234567890"] } },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects discord dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { discord: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('accepts discord dmPolicy="allowlist" with allowFrom entries', () => {
    const res = validateConfigObject({
      channels: { discord: { dmPolicy: "allowlist", allowFrom: ["123456789"] } },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects whatsapp dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { whatsapp: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('accepts whatsapp dmPolicy="allowlist" with allowFrom entries', () => {
    const res = validateConfigObject({
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+1234567890"] } },
    });
    expect(res.ok).toBe(true);
  });

  it('rejects telegram account dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          accounts: {
            bot1: { dmPolicy: "allowlist", botToken: "fake" },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("allowFrom"))).toBe(true);
    }
  });

  it('accepts telegram account dmPolicy="allowlist" with allowFrom entries', () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          accounts: {
            bot1: { dmPolicy: "allowlist", allowFrom: ["12345"], botToken: "fake" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
