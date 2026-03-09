import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("config validation allowed-values metadata", () => {
  it("adds allowed values for invalid union paths", () => {
    const result = validateConfigObjectRaw({
      update: { channel: "nightly" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "update.channel");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('(allowed: "stable", "beta", "dev")');
      expect(issue?.allowedValues).toEqual(["stable", "beta", "dev"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("keeps native enum messages while attaching allowed values metadata", () => {
    const result = validateConfigObjectRaw({
      channels: { signal: { dmPolicy: "maybe" } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.signal.dmPolicy");
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("expected one of");
      expect(issue?.message).not.toContain("(allowed:");
      expect(issue?.allowedValues).toEqual(["pairing", "allowlist", "open", "disabled"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("includes boolean variants for boolean-or-enum unions", () => {
    const result = validateConfigObjectRaw({
      channels: {
        telegram: {
          botToken: "x",
          allowFrom: ["*"],
          dmPolicy: "allowlist",
          streaming: "maybe",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "channels.telegram.streaming");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toEqual([
        "true",
        "false",
        "off",
        "partial",
        "block",
        "progress",
      ]);
    }
  });

  it("skips allowed-values hints for unions with open-ended branches", () => {
    const result = validateConfigObjectRaw({
      cron: { sessionRetention: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find((entry) => entry.path === "cron.sessionRetention");
      expect(issue).toBeDefined();
      expect(issue?.allowedValues).toBeUndefined();
      expect(issue?.allowedValuesHiddenCount).toBeUndefined();
      expect(issue?.message).not.toContain("(allowed:");
    }
  });

  it("surfaces unrecognized key name when bindings[].acp contains an unknown field (#40565)", () => {
    const result = validateConfigObjectRaw({
      bindings: [
        {
          type: "acp",
          agentId: "main",
          match: {
            channel: "telegram",
            peer: { kind: "direct", id: "12345" },
          },
          acp: {
            mode: "persistent",
            agent: "claude", // unrecognized key
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should surface a specific issue mentioning the unrecognized key "agent",
      // not just a generic "Invalid input" at bindings.0
      const issues = result.issues;
      const issue = issues.find((entry) => entry.path === "bindings.0.acp");
      expect(issue).toBeDefined();
      expect(issue?.path).toBe("bindings.0.acp");
      expect(issue?.message).toContain("agent");
    }
  });
});
