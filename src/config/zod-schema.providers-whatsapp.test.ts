import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

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

  it("preserves a disabled channel messageReceived hook", () => {
    expect(
      WhatsAppConfigSchema.parse({ pluginHooks: { messageReceived: false } }).pluginHooks,
    ).toEqual({ messageReceived: false });
  });

  it("accepts channel-level pluginHooks.pollVoteReceived", () => {
    const config = {
      pluginHooks: {
        pollVoteReceived: true,
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pluginHooks?.pollVoteReceived).toBe(true);
    }
  });

  it("accepts account-level pluginHooks.pollVoteReceived", () => {
    const config = {
      accounts: {
        work: {
          pluginHooks: {
            pollVoteReceived: true,
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
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
