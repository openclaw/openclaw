// Regresses rejection of legacy routing allowFrom config.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation-core.js";

describe("legacy config detection", () => {
  it("rejects the legacy routing key", () => {
    const res = validateConfigObject({ routing: { allowFrom: ["+15555550123"] } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"routing"');
    }
  });

  it("accepts per-agent tools.elevated overrides", () => {
    const res = validateConfigObject({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+15555550123"] },
        },
      },
      agents: {
        entries: {
          work: {
            workspace: "~/openclaw-work",
            tools: {
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config?.agents?.entries?.work?.tools?.elevated).toEqual({
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      });
    }
  });
  it("rejects telegram.requireMention", () => {
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("");
      expect(res.issues[0]?.message).toContain('"telegram"');
    }
  });
  it("rejects gateway.token", () => {
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway");
    }
  });
  it("flags a gateway.bind host alias as legacy", () => {
    const validated = validateConfigObject({ gateway: { bind: "0.0.0.0" } });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.issues.some((issue) => issue.path === "gateway.bind")).toBe(true);
    }
  });
});
