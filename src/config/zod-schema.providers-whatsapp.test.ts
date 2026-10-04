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
});
