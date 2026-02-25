import { describe, it, expect } from "vitest";
import { resolveWhatsAppGroupSystemPrompt } from "./whatsapp-shared.js";

describe("resolveWhatsAppGroupSystemPrompt", () => {
  it("returns undefined when no systemPrompt is configured", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {},
      groupId: "123@g.us",
    });

    expect(result).toBeUndefined();
  });

  it("returns account-level systemPrompt when only account systemPrompt is set", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: { systemPrompt: "You are a helpful assistant for this WhatsApp account." },
      groupId: "123@g.us",
    });

    expect(result).toBe("You are a helpful assistant for this WhatsApp account.");
  });

  it("returns account-level systemPrompt from specific account config", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: { systemPrompt: "You are my personal assistant." },
      groupId: "123@g.us",
    });

    expect(result).toBe("You are my personal assistant.");
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

  it("combines account and group systemPrompts with double newlines", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "You are a helpful assistant for this WhatsApp account.",
        groups: {
          "123@g.us": { systemPrompt: "This is a work group, keep responses professional." },
        },
      },
      groupId: "123@g.us",
    });

    expect(result).toBe(
      "You are a helpful assistant for this WhatsApp account.\n\nThis is a work group, keep responses professional.",
    );
  });

  it("combines account-specific and group systemPrompts", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "You are a work assistant.",
        groups: { "456@g.us": { systemPrompt: "Focus on project management topics." } },
      },
      groupId: "456@g.us",
    });

    expect(result).toBe("You are a work assistant.\n\nFocus on project management topics.");
  });

  it("trims whitespace from systemPrompts", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "  You are helpful  ",
        groups: { "123@g.us": { systemPrompt: "  Keep it brief  " } },
      },
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helpful\n\nKeep it brief");
  });

  it("ignores empty systemPrompts after trimming", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "You are helpful",
        groups: { "123@g.us": { systemPrompt: "   " } }, // Only whitespace
      },
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helpful");
  });

  it("returns account-level systemPrompt when groupId is not provided", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "You are helpful",
        groups: { "123@g.us": { systemPrompt: "Group specific prompt" } },
      },
      groupId: undefined,
    });

    expect(result).toBe("You are helpful");
  });

  it("returns account systemPrompt when group doesn't exist", () => {
    const result = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "You are helpful",
        groups: { "123@g.us": { systemPrompt: "Group specific prompt" } },
      },
      groupId: "999@g.us", // Non-existent group
    });

    expect(result).toBe("You are helpful");
  });

  it("handles pre-resolved account configs with group entries", () => {
    // Account with its own systemPrompt (as resolved by the caller)
    const personalResult = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "Personal assistant",
        groups: { "123@g.us": { systemPrompt: "Family group" } },
      },
      groupId: "123@g.us",
    });
    expect(personalResult).toBe("Personal assistant\n\nFamily group");

    // Account with systemPrompt inherited from root (already resolved by caller)
    const workResult = resolveWhatsAppGroupSystemPrompt({
      accountConfig: {
        systemPrompt: "Root assistant",
        groups: { "456@g.us": { systemPrompt: "Work group" } },
      },
      groupId: "456@g.us",
    });
    expect(workResult).toBe("Root assistant\n\nWork group");
  });

  it("falls back to wildcard '*' group when specific group is not configured", () => {
    const accountConfig = {
      systemPrompt: "Root prompt",
      groups: {
        "*": { systemPrompt: "Default group prompt" },
        "123@g.us": { systemPrompt: "Specific group prompt" },
      },
    };

    // Specific group config takes precedence
    expect(resolveWhatsAppGroupSystemPrompt({ accountConfig, groupId: "123@g.us" })).toBe(
      "Root prompt\n\nSpecific group prompt",
    );

    // Unknown group falls back to "*"
    expect(resolveWhatsAppGroupSystemPrompt({ accountConfig, groupId: "999@g.us" })).toBe(
      "Root prompt\n\nDefault group prompt",
    );
  });

  it("falls back to wildcard '*' in account-level groups", () => {
    expect(
      resolveWhatsAppGroupSystemPrompt({
        accountConfig: {
          systemPrompt: "Work assistant",
          groups: { "*": { systemPrompt: "Default work group prompt" } },
        },
        groupId: "456@g.us",
      }),
    ).toBe("Work assistant\n\nDefault work group prompt");
  });

  it("uses wildcard systemPrompt when specific group entry has no systemPrompt", () => {
    // Should still get wildcard's systemPrompt even though group entry exists
    expect(
      resolveWhatsAppGroupSystemPrompt({
        accountConfig: {
          systemPrompt: "Root prompt",
          groups: {
            "*": { systemPrompt: "Default group prompt" },
            "123@g.us": {}, // Group entry exists but only sets non-prompt fields (e.g. requireMention)
          },
        },
        groupId: "123@g.us",
      }),
    ).toBe("Root prompt\n\nDefault group prompt");
  });
});
