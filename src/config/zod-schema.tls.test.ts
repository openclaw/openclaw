import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation-core.js";

describe("gateway.tls schema", () => {
  it.each([
    ["certPath", ""],
    ["keyPath", "   "],
  ])("rejects blank %s", (key, value) => {
    const result = validateConfigObject({ gateway: { tls: { enabled: true, [key]: value } } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toContain(key);
    }
  });

  it("preserves exact non-empty cert and key path bytes", () => {
    const tls = {
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
    };
    const result = validateConfigObject({ gateway: { tls } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.tls).toEqual(tls);
    }
  });
});
