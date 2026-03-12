import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe('dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it('rejects telegram dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "allowlist", botToken: "fake" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("channels.telegram.allowFrom"))).toBe(true);
    }
  });

  it('rejects signal dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { signal: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("channels.signal.allowFrom"))).toBe(true);
    }
  });

  it('rejects discord dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { discord: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((i) => i.path.includes("channels.discord") && i.path.includes("allowFrom")),
      ).toBe(true);
    }
  });

  it('rejects whatsapp dmPolicy="allowlist" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { whatsapp: { dmPolicy: "allowlist" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("channels.whatsapp.allowFrom"))).toBe(true);
    }
  });

  it('accepts dmPolicy="pairing" without allowFrom', () => {
    const res = validateConfigObject({
      channels: { telegram: { dmPolicy: "pairing", botToken: "fake" } },
    });
    expect(res.ok).toBe(true);
  });
});

describe('account dmPolicy="allowlist" uses inherited allowFrom', () => {
  it("accepts telegram account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          allowFrom: ["12345"],
          accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects telegram account allowlist when neither account nor parent has allowFrom", () => {
    const res = validateConfigObject({
      channels: { telegram: { accounts: { bot1: { dmPolicy: "allowlist", botToken: "fake" } } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((i) => i.path.includes("channels.telegram.accounts.bot1.allowFrom")),
      ).toBe(true);
    }
  });

  it("accepts signal account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        signal: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts discord account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        discord: { allowFrom: ["123456789"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts slack account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          allowFrom: ["U123"],
          botToken: "xoxb-top",
          appToken: "xapp-top",
          accounts: {
            work: { dmPolicy: "allowlist", botToken: "xoxb-work", appToken: "xapp-work" },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts whatsapp account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        whatsapp: { allowFrom: ["+15550001111"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts imessage account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        imessage: { allowFrom: ["alice"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts irc account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: { irc: { allowFrom: ["nick"], accounts: { work: { dmPolicy: "allowlist" } } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts bluebubbles account allowlist when parent allowFrom exists", () => {
    const res = validateConfigObject({
      channels: {
        bluebubbles: { allowFrom: ["sender"], accounts: { work: { dmPolicy: "allowlist" } } },
      },
    });
    expect(res.ok).toBe(true);
  });
});
