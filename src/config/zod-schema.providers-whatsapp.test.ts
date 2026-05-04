import { describe, it, expect } from "vitest";
import { WhatsAppConfigSchema, WhatsAppAccountSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp prompt config Zod validation", () => {
  it("validates group-level systemPrompt", () => {
    const config = {
      groups: {
        "123@g.us": {
          debounceMs: 4500,
          debounceScope: "conversation",
          selfAddressedDebounceMs: 2500,
          debounceMaxWaitMs: 9000,
          debounceMaxBatchItems: 8,
          systemPrompt: "This is a work group",
          visibleReplies: "automatic",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["123@g.us"]?.debounceMs).toBe(4500);
      expect(result.data.groups?.["123@g.us"]?.debounceScope).toBe("conversation");
      expect(result.data.groups?.["123@g.us"]?.selfAddressedDebounceMs).toBe(2500);
      expect(result.data.groups?.["123@g.us"]?.debounceMaxWaitMs).toBe(9000);
      expect(result.data.groups?.["123@g.us"]?.debounceMaxBatchItems).toBe(8);
      expect(result.data.groups?.["123@g.us"]?.systemPrompt).toBe("This is a work group");
      expect(result.data.groups?.["123@g.us"]?.visibleReplies).toBe("automatic");
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

  it("validates WhatsAppAccountSchema directly", () => {
    const accountConfig = {
      name: "Personal Account",
      groups: {
        "family@g.us": {
          systemPrompt: "Keep responses family-friendly",
        },
      },
      direct: {
        "+15557654321": {
          systemPrompt: "Keep responses concise",
        },
      },
    };

    const result = WhatsAppAccountSchema.safeParse(accountConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.groups?.["family@g.us"]?.systemPrompt).toBe(
        "Keep responses family-friendly",
      );
      expect(result.data.direct?.["+15557654321"]?.systemPrompt).toBe("Keep responses concise");
    }
  });

  it("rejects invalid group debounce scope", () => {
    const result = WhatsAppConfigSchema.safeParse({
      groups: {
        "123@g.us": {
          debounceScope: "room",
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
