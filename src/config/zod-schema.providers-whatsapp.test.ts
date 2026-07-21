// Verifies WhatsApp provider schema parsing and defaults.
import { describe, it, expect } from "vitest";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp prompt config Zod validation", () => {
  it("validates group-level systemPrompt", () => {
    const config = {
      groups: {
        "123@g.us": {
          systemPrompt: "This is a work group",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["123@g.us"]?.systemPrompt).toBe("This is a work group");
    }
  });

  it("validates direct-level systemPrompt", () => {
    const config = {
      direct: {
        "+15551234567": {
          systemPrompt: "This is a VIP direct chat",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.direct?.["+15551234567"]?.systemPrompt).toBe("This is a VIP direct chat");
    }
  });

  it("validates combined group and direct prompt surfaces", () => {
    const config = {
      groups: {
        "*": {
          systemPrompt: "Default group prompt",
          debounceMs: 3000,
        },
      },
      direct: {
        "+15551234567": {
          systemPrompt: "Direct VIP",
          debounceMs: 0,
        },
      },
      accounts: {
        work: {
          groups: {
            "456@g.us": {
              systemPrompt: "Project team",
              debounceMs: 1000,
            },
          },
          direct: {
            "*": {
              systemPrompt: "Work direct default",
              debounceMs: 250,
            },
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["*"]?.systemPrompt).toBe("Default group prompt");
      expect(result.data.groups?.["*"]?.debounceMs).toBe(3000);
      expect(result.data.direct?.["+15551234567"]?.systemPrompt).toBe("Direct VIP");
      expect(result.data.direct?.["+15551234567"]?.debounceMs).toBe(0);
      expect(result.data.accounts?.work?.groups?.["456@g.us"]?.systemPrompt).toBe("Project team");
      expect(result.data.accounts?.work?.groups?.["456@g.us"]?.debounceMs).toBe(1000);
      expect(result.data.accounts?.work?.direct?.["*"]?.systemPrompt).toBe("Work direct default");
      expect(result.data.accounts?.work?.direct?.["*"]?.debounceMs).toBe(250);
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

  it("accepts channel-level pluginHooks.messageReceived", () => {
    const config = {
      pluginHooks: {
        messageReceived: true,
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pluginHooks?.messageReceived).toBe(true);
    }
  });

  it("accepts account-level pluginHooks.messageReceived", () => {
    const config = {
      accounts: {
        work: {
          pluginHooks: {
            messageReceived: true,
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts?.work?.pluginHooks?.messageReceived).toBe(true);
    }
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
