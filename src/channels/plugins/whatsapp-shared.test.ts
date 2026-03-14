import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveWhatsAppGroupSystemPrompt } from "./whatsapp-shared.js";

describe("resolveWhatsAppGroupSystemPrompt", () => {
  it("returns undefined when no systemPrompt is configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {},
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBeUndefined();
  });

  it("returns account-level systemPrompt when only account systemPrompt is set", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "You are a helpful assistant for this WhatsApp account.",
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBe("You are a helpful assistant for this WhatsApp account.");
  });

  it("returns account-level systemPrompt from specific account config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          accounts: {
            personal: {
              systemPrompt: "You are my personal assistant.",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "personal",
      groupId: "123@g.us",
    });

    expect(result).toBe("You are my personal assistant.");
  });

  it("returns group-level systemPrompt when only group systemPrompt is set", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          groups: {
            "123@g.us": {
              systemPrompt: "You are helping with group discussions.",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helping with group discussions.");
  });

  it("combines account and group systemPrompts with double newlines", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "You are a helpful assistant for this WhatsApp account.",
          groups: {
            "123@g.us": {
              systemPrompt: "This is a work group, keep responses professional.",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBe(
      "You are a helpful assistant for this WhatsApp account.\n\nThis is a work group, keep responses professional.",
    );
  });

  it("combines account-specific and group systemPrompts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              systemPrompt: "You are a work assistant.",
              groups: {
                "456@g.us": {
                  systemPrompt: "Focus on project management topics.",
                },
              },
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "work",
      groupId: "456@g.us",
    });

    expect(result).toBe("You are a work assistant.\n\nFocus on project management topics.");
  });

  it("trims whitespace from systemPrompts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "  You are helpful  ",
          groups: {
            "123@g.us": {
              systemPrompt: "  Keep it brief  ",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helpful\n\nKeep it brief");
  });

  it("ignores empty systemPrompts after trimming", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "You are helpful",
          groups: {
            "123@g.us": {
              systemPrompt: "   ", // Only whitespace
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "123@g.us",
    });

    expect(result).toBe("You are helpful");
  });

  it("returns account-level systemPrompt when groupId is not provided", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "You are helpful",
          groups: {
            "123@g.us": {
              systemPrompt: "Group specific prompt",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: undefined,
    });

    expect(result).toBe("You are helpful");
  });

  it("returns account systemPrompt when group doesn't exist", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "You are helpful",
          groups: {
            "123@g.us": {
              systemPrompt: "Group specific prompt",
            },
          },
        },
      },
    };

    const result = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "default",
      groupId: "999@g.us", // Non-existent group
    });

    expect(result).toBe("You are helpful");
  });

  it("handles account inheritance correctly", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          // Root config has systemPrompt
          systemPrompt: "Root assistant",
          accounts: {
            personal: {
              // Account overrides systemPrompt
              systemPrompt: "Personal assistant",
              groups: {
                "123@g.us": {
                  systemPrompt: "Family group",
                },
              },
            },
            work: {
              // Account doesn't override, inherits from root
              groups: {
                "456@g.us": {
                  systemPrompt: "Work group",
                },
              },
            },
          },
        },
      },
    };

    // Personal account overrides root
    const personalResult = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "personal",
      groupId: "123@g.us",
    });
    expect(personalResult).toBe("Personal assistant\n\nFamily group");

    // Work account inherits from root
    const workResult = resolveWhatsAppGroupSystemPrompt({
      cfg,
      accountId: "work",
      groupId: "456@g.us",
    });
    expect(workResult).toBe("Root assistant\n\nWork group");
  });

  it("falls back to wildcard '*' group when specific group is not configured", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "Root prompt",
          groups: {
            "*": {
              systemPrompt: "Default group prompt",
            },
            "123@g.us": {
              systemPrompt: "Specific group prompt",
            },
          },
        },
      },
    };

    // Specific group config takes precedence
    expect(
      resolveWhatsAppGroupSystemPrompt({ cfg, accountId: "default", groupId: "123@g.us" }),
    ).toBe("Root prompt\n\nSpecific group prompt");

    // Unknown group falls back to "*"
    expect(
      resolveWhatsAppGroupSystemPrompt({ cfg, accountId: "default", groupId: "999@g.us" }),
    ).toBe("Root prompt\n\nDefault group prompt");
  });

  it("falls back to wildcard '*' in account-level groups", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              systemPrompt: "Work assistant",
              groups: {
                "*": {
                  systemPrompt: "Default work group prompt",
                },
              },
            },
          },
        },
      },
    };

    expect(resolveWhatsAppGroupSystemPrompt({ cfg, accountId: "work", groupId: "456@g.us" })).toBe(
      "Work assistant\n\nDefault work group prompt",
    );
  });

  it("uses wildcard systemPrompt when specific group entry has no systemPrompt", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          systemPrompt: "Root prompt",
          groups: {
            "*": {
              systemPrompt: "Default group prompt",
            },
            "123@g.us": {
              // Group entry exists but only sets non-prompt fields (e.g. requireMention)
            },
          },
        },
      },
    };

    // Should still get wildcardʼs systemPrompt even though group entry exists
    expect(
      resolveWhatsAppGroupSystemPrompt({ cfg, accountId: "default", groupId: "123@g.us" }),
    ).toBe("Root prompt\n\nDefault group prompt");
  });
});
