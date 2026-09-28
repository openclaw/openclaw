// Verifies WhatsApp provider schema parsing and defaults.
import { describe, it, expect } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp prompt config Zod validation", () => {
  it("validates combined group and direct prompt surfaces", () => {
    const config = {
      groups: {
        "*": {
          systemPrompt: "Default group prompt",
        },
      },
      direct: {
        "+15551234567": {
          systemPrompt: "Direct VIP",
        },
      },
      accounts: {
        work: {
          groups: {
            "456@g.us": {
              systemPrompt: "Project team",
            },
          },
          direct: {
            "*": {
              systemPrompt: "Work direct default",
            },
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["*"]?.systemPrompt).toBe("Default group prompt");
      expect(result.data.direct?.["+15551234567"]?.systemPrompt).toBe("Direct VIP");
      expect(result.data.accounts?.work?.groups?.["456@g.us"]?.systemPrompt).toBe("Project team");
      expect(result.data.accounts?.work?.direct?.["*"]?.systemPrompt).toBe("Work direct default");
    }
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
    const config = {
      pluginHooks: {
        messageReceived: true,
        otherProp: "invalid",
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("accepts channel-level pluginHooks.messageReceived: false", () => {
    const config = {
      pluginHooks: {
        messageReceived: false,
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pluginHooks?.messageReceived).toBe(false);
    }
  });

  it("accepts account-level pluginHooks.messageReceived: false", () => {
    const config = {
      accounts: {
        work: {
          pluginHooks: {
            messageReceived: false,
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts?.work?.pluginHooks?.messageReceived).toBe(false);
    }
  });
});
