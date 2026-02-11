import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./config.js";
import { resolveChannelDMToolsPolicy } from "./group-policy.js";
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
