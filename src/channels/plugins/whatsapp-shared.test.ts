import { describe, it, expect } from "vitest";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "./whatsapp-shared.js";

describe("resolveWhatsAppGroupSystemPrompt", () => {
  it("returns undefined when no systemPrompt is configured", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {},
      groupId: "123@g.us",
    });

    expect(result).toBeUndefined();
  });

  it("returns group-level systemPrompt when only group systemPrompt is set", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "123@g.us": { systemPrompt: "You are helping with group discussions." } },
      },
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helping with group discussions.");
  });

  it("trims whitespace from systemPrompts", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "123@g.us": { systemPrompt: "  Keep it brief  " } },
      },
      groupId: "123@g.us",
    });

    expect(result).toBe("Keep it brief");
  });

  it("ignores empty systemPrompts after trimming", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "123@g.us": { systemPrompt: "   " } }, // Only whitespace
      },
      groupId: "123@g.us",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when groupId is not provided", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "123@g.us": { systemPrompt: "Group specific prompt" } },
      },
      groupId: undefined,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when group doesn't exist and there is no wildcard", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "123@g.us": { systemPrompt: "Group specific prompt" } },
      },
      groupId: "999@g.us", // Non-existent group
    });

    expect(result).toBeUndefined();
  });

  it("handles pre-resolved account configs with group entries", () => {
    const workResult = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        groups: { "456@g.us": { systemPrompt: "Work group" } },
      },
      groupId: "456@g.us",
    });
    expect(workResult).toBe("Work group");
  });

  it("falls back to wildcard '*' group when specific group is not configured", () => {
    const accountConfig = {
      groups: {
        "*": { systemPrompt: "Default group prompt" },
        "123@g.us": { systemPrompt: "Specific group prompt" },
      },
    };

    // Specific group config takes precedence
    expect(resolveWhatsAppGroupSystemPrompt({ accountConfig, groupId: "123@g.us" })).toBe(
      "Specific group prompt",
    );

    // Unknown group falls back to "*"
    expect(resolveWhatsAppGroupSystemPrompt({ accountConfig, groupId: "999@g.us" })).toBe(
      "Default group prompt",
    );
  });

  it("falls back to wildcard '*' in account-level groups", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        accountConfig: {
          groups: { "*": { systemPrompt: "Default work group prompt" } },
        },
        groupId: "456@g.us",
      }),
    ).toBe("Default work group prompt");
  });

  it("uses wildcard systemPrompt when specific group entry has no systemPrompt", () => {
    // Should still get wildcard's systemPrompt even though group entry exists
    expect(
      resolveWhatsAppGroupSystemPrompt({
        accountConfig: {
          groups: {
            "*": { systemPrompt: "Default group prompt" },
            "123@g.us": {}, // Group entry exists but only sets non-prompt fields (e.g. requireMention)
          },
        },
        groupId: "123@g.us",
      }),
    ).toBe("Default group prompt");
  });
});

describe("resolveWhatsAppDirectSystemPrompt", () => {
  it("returns undefined when no direct prompt is configured", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {},
      peerId: "+15551234567",
    });

    expect(result).toBeUndefined();
  });

  it("returns direct-level systemPrompt when only direct systemPrompt is set", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15551234567": { systemPrompt: "This is a VIP DM." } },
      },
      peerId: "+15551234567",
    });

    expect(result).toBe("This is a VIP DM.");
  });

  it("falls back to wildcard '*' direct config when specific peer is not configured", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        accountConfig: {
          direct: { "*": { systemPrompt: "Default work DM prompt" } },
        },
        peerId: "+15551234567",
      }),
    ).toBe("Default work DM prompt");
  });

  it("trims whitespace from direct systemPrompts", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15551234567": { systemPrompt: "  Keep it brief  " } },
      },
      peerId: "+15551234567",
    });

    expect(result).toBe("Keep it brief");
  });

  it("ignores empty direct systemPrompts after trimming", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15551234567": { systemPrompt: "   " } },
      },
      peerId: "+15551234567",
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when peerId is not provided", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15551234567": { systemPrompt: "Direct specific prompt" } },
      },
      peerId: undefined,
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined when direct chat doesn't exist and there is no wildcard", () => {
    const result = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15550001111": { systemPrompt: "Known direct prompt" } },
      },
      peerId: "+15559999999",
    });

    expect(result).toBeUndefined();
  });

  it("handles pre-resolved account configs with direct entries", () => {
    const personalResult = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15551234567": { systemPrompt: "Family direct chat" } },
      },
      peerId: "+15551234567",
    });
    expect(personalResult).toBe("Family direct chat");

    const workResult = resolveWhatsAppDirectSystemPrompt({
      accountConfig: {
        direct: { "+15557654321": { systemPrompt: "Work direct chat" } },
      },
      peerId: "+15557654321",
    });
    expect(workResult).toBe("Work direct chat");
  });

  it("uses wildcard systemPrompt when specific direct entry has no systemPrompt", () => {
    expect(
      resolveWhatsAppDirectSystemPrompt({
        accountConfig: {
          direct: {
            "*": { systemPrompt: "Default direct prompt" },
            "+15551234567": {},
          },
        },
        peerId: "+15551234567",
      }),
    ).toBe("Default direct prompt");
  });
});
