import { describe, expect, it } from "vitest";
import { buildConfigSchemaCore, lookupConfigSchema } from "./schema.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("Control UI remote image configuration", () => {
  it("normalizes exact Control UI remote image origins and rejects unsafe values", () => {
    const accepted = OpenClawSchema.safeParse({
      gateway: {
        controlUi: {
          remoteImageOrigins: [
            " HTTPS://IMAGES.example.test:443 ",
            "https://images.example.test.",
            "https://images.example.test",
            "https://192.0.2.39:30069",
            "https://images.example.test:0",
          ],
        },
      },
    });
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(accepted.data.gateway?.controlUi?.remoteImageOrigins).toEqual([
        "https://192.0.2.39:30069",
        "https://images.example.test",
        "https://images.example.test.",
        "https://images.example.test:0",
      ]);
    }
    for (const origin of [
      "*",
      "http://images.example.test",
      "ftp://images.example.test",
      "https://user@images.example.test",
      "https://*.example.test",
      "https://images.example.test/path",
      "https://images.example.test/",
      "https://images.example.test/a/..",
      "https://images.example.test?",
      "https://images.example.test#",
      "https://@images.example.test",
      "https:images.example.test",
      "https://images.example.test\\",
      "https://images.example.test?query=1",
      "https://images.example.test#fragment",
      "https://images.example.test:99999",
    ]) {
      expect(
        OpenClawSchema.safeParse({ gateway: { controlUi: { remoteImageOrigins: [origin] } } })
          .success,
      ).toBe(false);
    }
  });

  it("exposes remote image origins as a non-sensitive advanced setting", () => {
    const hint = lookupConfigSchema(
      buildConfigSchemaCore(),
      "gateway.controlUi.remoteImageOrigins",
    )?.hint;
    expect(hint).toMatchObject({ advanced: true, label: "Control UI Remote Image Origins" });
    expect(hint?.sensitive).not.toBe(true);
    expect(hint?.help).toContain("HTTP origins are unsupported");
  });
});
