import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("WhatsApp account schema dmPolicy inheritance", () => {
  it("does not inject default dmPolicy into account blocks that omit it", () => {
    const res = validateConfigObject({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          accounts: {
            work: { allowFrom: ["+15559999999"] },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    const work = res.config.channels?.whatsapp?.accounts?.work;
    expect(work?.dmPolicy).toBeUndefined();
  });

  it("still accepts an explicit account-level dmPolicy", () => {
    const res = validateConfigObject({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
          accounts: {
            work: { dmPolicy: "pairing", allowFrom: ["+15559999999"] },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.config.channels?.whatsapp?.accounts?.work?.dmPolicy).toBe("pairing");
  });
});
