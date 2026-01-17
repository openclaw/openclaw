import { describe, expect, it } from "vitest";
import { resolveMediaUnderstandingScope } from "./scope.js";

describe("resolveMediaUnderstandingScope", () => {
  it("defaults to allow when scope is undefined", () => {
    expect(resolveMediaUnderstandingScope({})).toBe("allow");
  });

  it("uses first matching rule", () => {
    const decision = resolveMediaUnderstandingScope({
      scope: {
        default: "deny",
        rules: [
          { action: "allow", match: { channel: "whatsapp" } },
          { action: "deny", match: { channel: "whatsapp", chatType: "direct" } },
        ],
      },
      channel: "whatsapp",
      chatType: "direct",
      sessionKey: "whatsapp:direct:123",
    });
    expect(decision).toBe("allow");
  });

  it("matches keyPrefix when provided", () => {
    const decision = resolveMediaUnderstandingScope({
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { keyPrefix: "agent:main:" } }],
      },
      sessionKey: "agent:main:whatsapp:group:123",
    });
    expect(decision).toBe("allow");
  });

  it("matches keyPrefix case-insensitively", () => {
    const decision = resolveMediaUnderstandingScope({
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { keyPrefix: "agent:main:" } }],
      },
      sessionKey: "AGENT:MAIN:WHATSAPP:GROUP:123",
    });
    expect(decision).toBe("allow");
  });
});
