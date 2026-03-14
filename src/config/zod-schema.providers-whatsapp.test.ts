import { describe, it, expect } from "vitest";
import { WhatsAppConfigSchema, WhatsAppAccountSchema } from "./zod-schema.providers-whatsapp.js";

describe("WhatsApp systemPrompt Zod validation", () => {
  it("validates root-level systemPrompt", () => {
    const config = {
      systemPrompt: "You are a helpful assistant",
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBe("You are a helpful assistant");
    }
  });

  it("validates account-level systemPrompt", () => {
    const config = {
      accounts: {
        personal: {
          systemPrompt: "You are my personal assistant",
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.accounts?.personal?.systemPrompt).toBe("You are my personal assistant");
    }
  });

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

  it("validates combined account and group systemPrompts", () => {
    const config = {
      systemPrompt: "Global assistant",
      accounts: {
        work: {
          systemPrompt: "Work assistant",
          groups: {
            "456@g.us": {
              systemPrompt: "Project team",
            },
          },
        },
      },
    };

    const result = WhatsAppConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBe("Global assistant");
      expect(result.data.accounts?.work?.systemPrompt).toBe("Work assistant");
      expect(result.data.accounts?.work?.groups?.["456@g.us"]?.systemPrompt).toBe("Project team");
    }
  });

  it("validates WhatsAppAccountSchema directly", () => {
    const accountConfig = {
      name: "Personal Account",
      systemPrompt: "You are my personal WhatsApp assistant",
      groups: {
        "family@g.us": {
          systemPrompt: "Keep responses family-friendly",
        },
      },
    };

    const result = WhatsAppAccountSchema.safeParse(accountConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBe("You are my personal WhatsApp assistant");
      expect(result.data.groups?.["family@g.us"]?.systemPrompt).toBe(
        "Keep responses family-friendly",
      );
    }
  });
});
