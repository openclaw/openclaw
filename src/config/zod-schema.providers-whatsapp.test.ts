// Verifies WhatsApp provider schema parsing and defaults.
import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp pollVoteRetentionMs Zod validation", () => {
  it("accepts a value within the 24-hour maximum", () => {
    const result = WhatsAppConfigSchema.safeParse({ pollVoteRetentionMs: 3_600_000 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pollVoteRetentionMs).toBe(3_600_000);
    }
  });

  it("rejects a value above the 24-hour maximum", () => {
    const result = WhatsAppConfigSchema.safeParse({
      pollVoteRetentionMs: 24 * 60 * 60 * 1000 + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive value", () => {
    const result = WhatsAppConfigSchema.safeParse({ pollVoteRetentionMs: 0 });
    expect(result.success).toBe(false);
  });
});

describe("WhatsAppConfigSchema", () => {
  it("preserves group and direct prompts at root and account scope", () => {
    const config = {
      groups: { "*": { systemPrompt: "Default group prompt" } },
      direct: { "+15551234567": { systemPrompt: "Direct VIP" } },
      accounts: {
        work: {
          groups: { "456@g.us": { systemPrompt: "Project team" } },
          direct: { "*": { systemPrompt: "Work direct default" } },
        },
      },
    };
    expect(WhatsAppConfigSchema.parse(config)).toMatchObject(config);
  });

  it("keeps exposeErrorText out of generated config surfaces", () => {
    const schema = WhatsAppConfigSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    }) as {
      properties?: {
        exposeErrorText?: unknown;
        accounts?: {
          additionalProperties?: {
            properties?: {
              exposeErrorText?: unknown;
            };
          };
        };
      };
    };

    expect(schema.properties?.exposeErrorText).toBeUndefined();
    expect(schema.properties?.accounts?.additionalProperties?.properties?.exposeErrorText).toBe(
      undefined,
    );
  });

  it("rejects extra properties in pluginHooks", () => {
    const result = WhatsAppConfigSchema.safeParse({
      pluginHooks: { messageReceived: true, otherProp: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("preserves a disabled channel messageReceived hook", () => {
    expect(
      WhatsAppConfigSchema.parse({ pluginHooks: { messageReceived: false } }).pluginHooks,
    ).toEqual({ messageReceived: false });
  });

  it("accepts account-level pluginHooks.messageReceived: false", () => {
    const result = WhatsAppConfigSchema.safeParse({
      accounts: { work: { pluginHooks: { messageReceived: false } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts?.work?.pluginHooks?.messageReceived).toBe(false);
    }
  });

  it("accepts channel-level pluginHooks.pollVoteReceived", () => {
    const result = WhatsAppConfigSchema.safeParse({ pluginHooks: { pollVoteReceived: true } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pluginHooks?.pollVoteReceived).toBe(true);
    }
  });

  it("accepts account-level pluginHooks.pollVoteReceived", () => {
    const result = WhatsAppConfigSchema.safeParse({
      accounts: { work: { pluginHooks: { pollVoteReceived: true } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts?.work?.pluginHooks?.pollVoteReceived).toBe(true);
    }
  });

  it("defaults pluginHooks.pollVoteReceived to undefined (disabled) when omitted", () => {
    const result = WhatsAppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pluginHooks?.pollVoteReceived).toBeUndefined();
    }
  });
});
