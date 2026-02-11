import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import {
  resolveChannelDMToolsPolicy,
  resolveContactContext,
  resolveContactEntry,
  resolveContactGroups,
} from "./group-policy.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("resolveChannelDMToolsPolicy", () => {
  it("applies sender-specific DM policies on verified channels", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          toolsBySender: {
            "+14155550101": { allow: ["read", "exec"] },
            "*": { deny: ["*"] },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+14155550101",
      }),
    ).toEqual({ allow: ["read", "exec"] });
  });

  it("falls back to wildcard for unknown senders", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          toolsBySender: {
            "+14155550101": { allow: ["read", "exec"] },
            "*": { deny: ["*"] },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+14155550199",
      }),
    ).toEqual({ deny: ["*"] });
  });

  it("ignores sender-specific entries when channel is unverified", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          verified: false,
          toolsBySender: {
            "+14155550101": { allow: ["read", "exec"] },
            "*": { deny: ["*"] },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+14155550101",
      }),
    ).toEqual({ deny: ["*"] });
  });

  it("inherits channel-level verified setting when account-level verified is omitted", () => {
    const cfg = OpenClawSchema.parse({
      channels: {
        whatsapp: {
          verified: false,
          toolsBySender: {
            "*": { deny: ["*"] },
          },
          accounts: {
            work: {
              toolsBySender: {
                "+14155550101": { allow: ["exec"] },
                "*": { allow: ["read"] },
              },
            },
          },
        },
      },
    });

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        accountId: "work",
        senderE164: "+14155550101",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("uses account-level DM policies and verified overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          verified: true,
          toolsBySender: {
            "*": { deny: ["*"] },
          },
          accounts: {
            work: {
              verified: false,
              toolsBySender: {
                "+14155550101": { allow: ["exec"] },
                "*": { allow: ["read"] },
              },
            },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        accountId: "work",
        senderE164: "+14155550101",
      }),
    ).toEqual({ allow: ["read"] });
  });

  it("treats sms as unverified by default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        sms: {
          toolsBySender: {
            "+14155550101": { allow: ["exec"] },
            "*": { deny: ["*"] },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "sms",
        senderE164: "+14155550101",
      }),
    ).toEqual({ deny: ["*"] });
  });
});

describe("contact groups", () => {
  it("expands @group references to member phone numbers", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        entries: {
          alice: { phone: "+15551234567", name: "Alice" },
          bob: { phone: "+15559876543", name: "Bob" },
        },
        groups: {
          friends: {
            members: ["alice", "bob"],
            tools: { allow: ["web_search"] },
          },
        },
      },
      channels: {
        whatsapp: {
          toolsBySender: {
            "@friends": {},
            "*": { deny: ["*"] },
          },
        },
      },
    };

    // Alice should get friend permissions
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ allow: ["web_search"] });

    // Bob should also get friend permissions
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15559876543",
      }),
    ).toEqual({ allow: ["web_search"] });

    // Unknown sender gets wildcard
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15550000000",
      }),
    ).toEqual({ deny: ["*"] });
  });

  it("first matching group wins for contacts in multiple groups", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        entries: {
          alice: { phone: "+15551234567", name: "Alice" },
        },
        groups: {
          family: {
            members: ["alice"],
            tools: { allow: ["*"] },
          },
          friends: {
            members: ["alice"],
            tools: { allow: ["web_search"] },
          },
        },
      },
      channels: {
        whatsapp: {
          toolsBySender: {
            "@family": {}, // Listed first = higher priority
            "@friends": {},
            "*": { deny: ["*"] },
          },
        },
      },
    };

    // Alice is in both groups, but @family is listed first
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ allow: ["*"] });
  });

  it("entry-level tools override group-level tools", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        entries: {
          alice: {
            phone: "+15551234567",
            name: "Alice",
            tools: { allow: ["*"] }, // Entry-level override
          },
          bob: { phone: "+15559876543", name: "Bob" },
        },
        groups: {
          friends: {
            members: ["alice", "bob"],
            tools: { allow: ["web_search"] }, // Group default
          },
        },
      },
      channels: {
        whatsapp: {
          toolsBySender: {
            "@friends": {},
            "*": { deny: ["*"] },
          },
        },
      },
    };

    // Alice has entry-level override
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ allow: ["*"] });

    // Bob uses group default
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15559876543",
      }),
    ).toEqual({ allow: ["web_search"] });
  });

  it("allows inline phone numbers in group members", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        groups: {
          vips: {
            members: ["+15551234567", "+15559876543"], // Inline phones
            tools: { allow: ["*"] },
          },
        },
      },
      channels: {
        whatsapp: {
          toolsBySender: {
            "@vips": {},
            "*": { deny: ["*"] },
          },
        },
      },
    };

    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ allow: ["*"] });
  });

  it("direct phone entries still work alongside group references", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        groups: {
          friends: {
            members: ["+15559876543"],
            tools: { allow: ["web_search"] },
          },
        },
      },
      channels: {
        whatsapp: {
          toolsBySender: {
            "+15551234567": { allow: ["*"] }, // Direct entry
            "@friends": {},
            "*": { deny: ["*"] },
          },
        },
      },
    };

    // Direct entry
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ allow: ["*"] });

    // Group member
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15559876543",
      }),
    ).toEqual({ allow: ["web_search"] });
  });

  it("ignores undefined group references gracefully", () => {
    const cfg: OpenClawConfig = {
      channels: {
        whatsapp: {
          toolsBySender: {
            "@nonexistent": { allow: ["read"] },
            "*": { deny: ["*"] },
          },
        },
      },
    };

    // Unknown group is ignored, falls through to wildcard
    expect(
      resolveChannelDMToolsPolicy({
        cfg,
        channel: "whatsapp",
        senderE164: "+15551234567",
      }),
    ).toEqual({ deny: ["*"] });
  });
});

describe("resolveContactEntry", () => {
  it("finds a contact entry by phone number", () => {
    const contacts = {
      entries: {
        alice: { phone: "+15551234567", name: "Alice Smith", email: "alice@example.com" },
        bob: { phone: "+15559876543", name: "Bob" },
      },
    };

    const result = resolveContactEntry(contacts, "+15551234567");
    expect(result).toEqual({
      key: "alice",
      phone: "+15551234567",
      name: "Alice Smith",
      email: "alice@example.com",
    });
  });

  it("returns undefined for unknown phone numbers", () => {
    const contacts = {
      entries: {
        alice: { phone: "+15551234567", name: "Alice" },
      },
    };

    expect(resolveContactEntry(contacts, "+19990000000")).toBeUndefined();
  });

  it("returns undefined when contacts is undefined", () => {
    expect(resolveContactEntry(undefined, "+15551234567")).toBeUndefined();
  });

  it("returns undefined when phone is undefined", () => {
    const contacts = {
      entries: {
        alice: { phone: "+15551234567", name: "Alice" },
      },
    };
    expect(resolveContactEntry(contacts, undefined)).toBeUndefined();
  });
});

describe("resolveContactGroups", () => {
  it("finds all groups a contact belongs to", () => {
    const contacts = {
      entries: {
        alice: { phone: "+15551234567", name: "Alice" },
      },
      groups: {
        family: {
          members: ["alice"],
          instructions: "Be casual and friendly.",
        },
        vips: {
          members: ["alice", "+15559999999"],
          instructions: "Give priority support.",
        },
        strangers: {
          members: ["+19990000000"],
        },
      },
    };

    const result = resolveContactGroups(contacts, "+15551234567");
    expect(result).toEqual([
      { key: "family", instructions: "Be casual and friendly." },
      { key: "vips", instructions: "Give priority support." },
    ]);
  });

  it("handles inline phone numbers in group members", () => {
    const contacts = {
      groups: {
        vips: {
          members: ["+15551234567"],
          instructions: "VIP treatment",
        },
      },
    };

    const result = resolveContactGroups(contacts, "+15551234567");
    expect(result).toEqual([{ key: "vips", instructions: "VIP treatment" }]);
  });

  it("returns empty array for unknown phone numbers", () => {
    const contacts = {
      groups: {
        friends: {
          members: ["+15551234567"],
        },
      },
    };

    expect(resolveContactGroups(contacts, "+19990000000")).toEqual([]);
  });
});

describe("resolveContactContext", () => {
  const baseCfg: OpenClawConfig = {
    contacts: {
      entries: {
        alice: { phone: "+15551234567", name: "Alice Smith" },
        bob: { phone: "+15559876543", name: "Bob" },
      },
      groups: {
        close_friends: {
          members: ["alice", "bob"],
          instructions: "Be casual, no formal greetings needed.",
        },
        family: {
          members: ["alice"],
          instructions: "Share personal updates freely.",
        },
      },
    },
    channels: {
      whatsapp: { verified: true },
      sms: { verified: false },
    },
  };

  it("returns full context for verified channel + known contact", () => {
    const result = resolveContactContext({
      cfg: baseCfg,
      channel: "whatsapp",
      senderE164: "+15551234567",
      ownerNumbers: ["+14155550100"],
    });

    expect(result.verified).toBe(true);
    expect(result.isOwner).toBe(false);
    expect(result.entry).toEqual({
      key: "alice",
      phone: "+15551234567",
      name: "Alice Smith",
    });
    expect(result.groups).toEqual([
      { key: "close_friends", instructions: "Be casual, no formal greetings needed." },
      { key: "family", instructions: "Share personal updates freely." },
    ]);
    expect(result.instructions).toBe(
      "Be casual, no formal greetings needed.\n\nShare personal updates freely.",
    );
  });

  it("identifies owner from ownerNumbers", () => {
    const result = resolveContactContext({
      cfg: baseCfg,
      channel: "whatsapp",
      senderE164: "+14155550100",
      ownerNumbers: ["+14155550100", "+14155550101"],
    });

    expect(result.isOwner).toBe(true);
    expect(result.verified).toBe(true);
  });

  it("returns minimal context for unverified channel", () => {
    const result = resolveContactContext({
      cfg: baseCfg,
      channel: "sms",
      senderE164: "+15551234567", // Alice's number, but SMS is unverified
      ownerNumbers: [],
    });

    expect(result.verified).toBe(false);
    expect(result.entry).toBeUndefined();
    expect(result.groups).toEqual([]);
    expect(result.instructions).toBeUndefined();
  });

  it("returns minimal context for unknown contact on verified channel", () => {
    const result = resolveContactContext({
      cfg: baseCfg,
      channel: "whatsapp",
      senderE164: "+19990000000", // Unknown number
      ownerNumbers: [],
    });

    expect(result.verified).toBe(true);
    expect(result.entry).toBeUndefined();
    expect(result.groups).toEqual([]);
    expect(result.instructions).toBeUndefined();
    expect(result.isOwner).toBe(false);
  });

  it("uses default verified=true for whatsapp when not explicitly set", () => {
    const cfg: OpenClawConfig = {
      contacts: baseCfg.contacts,
      // No channels config — uses defaults
    };

    const result = resolveContactContext({
      cfg,
      channel: "whatsapp",
      senderE164: "+15551234567",
      ownerNumbers: [],
    });

    expect(result.verified).toBe(true);
    expect(result.entry?.name).toBe("Alice Smith");
  });

  it("uses default verified=false for sms when not explicitly set", () => {
    const cfg: OpenClawConfig = {
      contacts: baseCfg.contacts,
    };

    const result = resolveContactContext({
      cfg,
      channel: "sms",
      senderE164: "+15551234567",
      ownerNumbers: [],
    });

    expect(result.verified).toBe(false);
    expect(result.entry).toBeUndefined();
  });

  it("handles contact in group without instructions", () => {
    const cfg: OpenClawConfig = {
      contacts: {
        groups: {
          basic: {
            members: ["+15551234567"],
            // No instructions
          },
        },
      },
    };

    const result = resolveContactContext({
      cfg,
      channel: "whatsapp",
      senderE164: "+15551234567",
      ownerNumbers: [],
    });

    expect(result.groups).toEqual([{ key: "basic", instructions: undefined }]);
    expect(result.instructions).toBeUndefined();
  });
});
