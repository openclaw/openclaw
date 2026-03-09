import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("validateConfigObjectRaw (unrecognized_keys)", () => {
  it("includes the offending unknown keys in the returned issue message", () => {
    // Intentionally provide unknown keys at the root and under a known object.
    // We only assert that the message includes the key names, not the exact wording,
    // to keep this test robust across Zod version message tweaks.
    const result = validateConfigObjectRaw({
      gateway: { bind: "loopback", totallyNotARealGatewayKey: true },
      totallyNotARealRootKey: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    const messages = result.issues.map((iss) => iss.message).join("\n");
    expect(messages).toContain("totallyNotARealGatewayKey");
    expect(messages).toContain("totallyNotARealRootKey");
  });
});
