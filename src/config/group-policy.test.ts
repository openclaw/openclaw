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
