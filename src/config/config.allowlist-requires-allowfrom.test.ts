// Regresses allowlist config requiring explicit allowFrom entries.
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe('WhatsApp dmPolicy="allowlist" requires non-empty effective allowFrom', () => {
  it("rejects an allowlist without allowFrom", () => {
    const result = WhatsAppConfigSchema.safeParse({ dmPolicy: "allowlist" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["allowFrom"] }));
    }
  });

  it("accepts an account allowlist when parent allowFrom exists", () => {
    expect(
      WhatsAppConfigSchema.safeParse({
        allowFrom: ["+15550001111"],
        accounts: { work: { dmPolicy: "allowlist" } },
      }).success,
    ).toBe(true);
  });
});
