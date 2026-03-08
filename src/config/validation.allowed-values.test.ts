import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";

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
});

describe("ElevatedAllowFromSchema — legacy array coercion (#39500)", () => {
  it("accepts canonical record format", () => {
    const result = ElevatedAllowFromSchema.safeParse({
      discord: ["userId1", "userId2"],
      "*": ["adminId"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ discord: ["userId1", "userId2"], "*": ["adminId"] });
    }
  });

  it("coerces legacy array shorthand to {'*': array}", () => {
    const result = ElevatedAllowFromSchema.safeParse(["userId1", "userId2"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ "*": ["userId1", "userId2"] });
    }
  });

  it("passes through undefined (optional field)", () => {
    const result = ElevatedAllowFromSchema.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeUndefined();
    }
  });

  it("coerces empty array to {'*': []}", () => {
    const result = ElevatedAllowFromSchema.safeParse([]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ "*": [] });
    }
  });
});
