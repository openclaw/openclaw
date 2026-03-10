import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  applySetupAccountConfigPatch,
  moveSingleAccountChannelSectionToDefaultAccount,
} from "./setup-helpers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("moves whatsapp allowSendTo from root to accounts.default", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+111"],
          allowSendTo: ["+222"],
          dmPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    const updated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "whatsapp",
    });

    const channel = (updated.channels as Record<string, unknown>).whatsapp as Record<
      string,
      unknown
    >;
    expect(channel.allowSendTo).toBeUndefined();

    const accounts = channel.accounts as Record<string, Record<string, unknown>>;
    expect(accounts[DEFAULT_ACCOUNT_ID]?.allowSendTo).toEqual(["+222"]);
    expect(accounts[DEFAULT_ACCOUNT_ID]?.allowFrom).toEqual(["+111"]);
  });

  it("does not rewrite when accounts already exist", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowSendTo: ["+222"],
          accounts: {
            default: { dmPolicy: "allowlist" },
          },
        },
      },
    } as OpenClawConfig;

    const updated = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "whatsapp",
    });

    expect(updated).toEqual(cfg);
  });
});

describe("applySetupAccountConfigPatch", () => {
  it("patches top-level config for default account and enables channel", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          zalo: {
            webhookPath: "/old",
            enabled: false,
          },
        },
      }),
      channelKey: "zalo",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { webhookPath: "/new", botToken: "tok" },
    });

    expect(next.channels?.zalo).toMatchObject({
      enabled: true,
      webhookPath: "/new",
      botToken: "tok",
    });
  });

  it("patches named account config and enables both channel and account", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          zalo: {
            enabled: false,
            accounts: {
              work: { botToken: "old", enabled: false },
            },
          },
        },
      }),
      channelKey: "zalo",
      accountId: "work",
      patch: { botToken: "new" },
    });

    expect(next.channels?.zalo).toMatchObject({
      enabled: true,
      accounts: {
        work: { enabled: true, botToken: "new" },
      },
    });
  });

  it("normalizes account id and preserves other accounts", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          zalo: {
            accounts: {
              personal: { botToken: "personal-token" },
            },
          },
        },
      }),
      channelKey: "zalo",
      accountId: "Work Team",
      patch: { botToken: "work-token" },
    });

    expect(next.channels?.zalo).toMatchObject({
      accounts: {
        personal: { botToken: "personal-token" },
        "work-team": { enabled: true, botToken: "work-token" },
      },
    });
  });
});
