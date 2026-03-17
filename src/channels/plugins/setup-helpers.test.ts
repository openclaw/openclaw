import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  applySetupAccountConfigPatch,
  createPatchedAccountSetupAdapter,
  prepareScopedSetupConfig,
} from "./setup-helpers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

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

  it("patches named account config and preserves existing account enabled flag", () => {
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
        work: { enabled: false, botToken: "new" },
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

describe("createPatchedAccountSetupAdapter", () => {
  it("stores default-account patch at channel root", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "zalo",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { zalo: { enabled: false } } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Personal", token: "tok" },
    });

    expect(next.channels?.zalo).toMatchObject({
      enabled: true,
      name: "Personal",
      botToken: "tok",
    });
  });

  it("migrates base name into the default account before patching a named account", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "zalo",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({
        channels: {
          zalo: {
            name: "Personal",
            accounts: {
              work: { botToken: "old" },
            },
          },
        },
      }),
      accountId: "Work Team",
      input: { name: "Work", token: "new" },
    });

    expect(next.channels?.zalo).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        work: { botToken: "old" },
        "work-team": { enabled: true, name: "Work", botToken: "new" },
      },
    });
    expect(next.channels?.zalo).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "whatsapp",
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { whatsapp: {} } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Phone", authDir: "/tmp/auth" },
    });

    expect(next.channels?.whatsapp).toMatchObject({
      accounts: {
        default: {
          enabled: true,
          name: "Phone",
          authDir: "/tmp/auth",
        },
      },
    });
    expect(next.channels?.whatsapp).not.toHaveProperty("enabled");
    expect(next.channels?.whatsapp).not.toHaveProperty("authDir");
  });
});

describe("prepareScopedSetupConfig", () => {
  it("stores the name and migrates it for named accounts when requested", () => {
    const next = prepareScopedSetupConfig({
      cfg: asConfig({
        channels: {
          bluebubbles: {
            name: "Personal",
          },
        },
      }),
      channelKey: "bluebubbles",
      accountId: "Work Team",
      name: "Work",
      migrateBaseName: true,
    });

    expect(next.channels?.bluebubbles).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        "work-team": { name: "Work" },
      },
    });
    expect(next.channels?.bluebubbles).not.toHaveProperty("name");
  });

  it("keeps the base shape for the default account when migration is disabled", () => {
    const next = prepareScopedSetupConfig({
      cfg: asConfig({ channels: { irc: { enabled: true } } }),
      channelKey: "irc",
      accountId: DEFAULT_ACCOUNT_ID,
      name: "Libera",
    });

    expect(next.channels?.irc).toMatchObject({
      enabled: true,
      name: "Libera",
    });
  });
});
