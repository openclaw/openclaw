import { expectDefined } from "@openclaw/normalization-core";
// Setup helper tests cover channel setup helper outputs and lifecycle cleanup.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applySetupAccountConfigPatch,
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
  patchScopedAccountConfig,
} from "./setup-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function channelRecord(cfg: OpenClawConfig, channelKey: string): Record<string, unknown> {
  return requireRecord(cfg.channels?.[channelKey]);
}

function accountsRecord(channel: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(channel.accounts);
}

function accountRecord(
  channel: Record<string, unknown>,
  accountId: string,
): Record<string, unknown> {
  return requireRecord(accountsRecord(channel)[accountId]);
}

const matrixSingleAccountKeysToMove = [
  "homeserver",
  "userId",
  "accessToken",
  "allowBots",
  "deviceId",
  "deviceName",
  "encryption",
] as const;
const matrixNamedAccountPromotionKeys = [
  "accessToken",
  "deviceId",
  "deviceName",
  "encryption",
  "homeserver",
  "userId",
] as const;
const telegramSingleAccountKeysToMove = ["streaming"] as const;
const matrixSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: matrixSingleAccountKeysToMove,
  namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
} as ChannelSetupAdapter;

function collectNamedAccountIds(accounts: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const accountId of Object.keys(accounts)) {
    if (accountId) {
      ids.push(accountId);
    }
  }
  return ids;
}

function resolveMatrixSingleAccountPromotionTarget(params: {
  channel: { defaultAccount?: string; accounts?: Record<string, unknown> };
}): string {
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount = params.channel.defaultAccount?.trim()
    ? normalizeAccountId(params.channel.defaultAccount)
    : undefined;
  if (normalizedDefaultAccount) {
    return (
      Object.keys(accounts).find(
        (accountId) => normalizeAccountId(accountId) === normalizedDefaultAccount,
      ) ?? DEFAULT_ACCOUNT_ID
    );
  }
  const namedAccounts = collectNamedAccountIds(accounts);
  return namedAccounts.length === 1
    ? expectDefined(namedAccounts[0], "namedAccounts[0] test invariant")
    : DEFAULT_ACCOUNT_ID;
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          setup: {
            singleAccountKeysToMove: matrixSingleAccountKeysToMove,
            namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
            resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
          },
        },
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          setup: {
            singleAccountKeysToMove: telegramSingleAccountKeysToMove,
          },
        },
      },
    ]),
  );
});

afterAll(() => {
  resetPluginRuntimeStateForTest();
});

describe("applySetupAccountConfigPatch", () => {
  it("normalizes account id and preserves other accounts", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            accounts: {
              personal: { botToken: "personal-token" },
            },
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: "Work Team",
      patch: { botToken: "work-token" },
    });

    const channel = channelRecord(next, "demo-setup");
    const personal = accountRecord(channel, "personal");
    const workTeam = accountRecord(channel, "work-team");
    expect(personal.botToken).toBe("personal-token");
    expect(workTeam.enabled).toBe(true);
    expect(workTeam.botToken).toBe("work-token");
  });
});

describe("patchScopedAccountConfig credential clearing", () => {
  it("clears only default-account credential fields before applying their replacement", () => {
    const next = patchScopedAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            token: "old-token",
            tokenFile: "/old/token",
            webhookPath: "/keep",
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: DEFAULT_ACCOUNT_ID,
      clearFields: ["token", "tokenFile"],
      patch: { token: "new-token" },
      ensureChannelEnabled: false,
    });

    expect(channelRecord(next, "demo-setup")).toEqual({
      enabled: false,
      token: "new-token",
      webhookPath: "/keep",
    });
  });
});

describe("createPatchedAccountSetupAdapter", () => {
  it("stores default-account patch at channel root", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-setup",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { "demo-setup": { enabled: false } } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Personal", token: "tok" },
    });

    const channel = channelRecord(next, "demo-setup");
    expect(channel.enabled).toBe(true);
    expect(channel.name).toBe("Personal");
    expect(channel.botToken).toBe("tok");
  });

  it("migrates base name into the default account before patching a named account", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-setup",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
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

    const channel = channelRecord(next, "demo-setup");
    const defaultAccount = accountRecord(channel, "default");
    const work = accountRecord(channel, "work");
    const workTeam = accountRecord(channel, "work-team");
    expect(defaultAccount.name).toBe("Personal");
    expect(work.botToken).toBe("old");
    expect(workTeam.enabled).toBe(true);
    expect(workTeam.name).toBe("Work");
    expect(workTeam.botToken).toBe("new");
    expect(next.channels?.["demo-setup"]).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-accounts",
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { "demo-accounts": {} } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Phone", authDir: "/tmp/auth" },
    });

    const channel = channelRecord(next, "demo-accounts");
    const defaultAccount = accountRecord(channel, "default");
    expect(defaultAccount.enabled).toBe(true);
    expect(defaultAccount.name).toBe("Phone");
    expect(defaultAccount.authDir).toBe("/tmp/auth");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("enabled");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("authDir");
  });
});

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("does not add a default when an ordinary named account already exists and no keys move", () => {
    const cfg = asConfig({ channels: { demo: { enabled: true, accounts: { ada: {} } } } });
    expect(moveSingleAccountChannelSectionToDefaultAccount({ cfg, channelKey: "demo" })).toBe(cfg);
  });

  it("promotes legacy Matrix keys into the sole named account when defaultAccount is unset", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "token",
            accounts: {
              main: {
                enabled: true,
              },
            },
          },
        },
      }),
      channelKey: "matrix",
      setupSurface: matrixSetupSurface,
    });

    const channel = channelRecord(next, "matrix");
    const main = accountRecord(channel, "main");
    expect(main.enabled).toBe(true);
    expect(main.homeserver).toBe("https://matrix.example.org");
    expect(main.userId).toBe("@bot:example.org");
    expect(main.accessToken).toBe("token");
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
  });

  it("preserves explicit named-account values over promoted root defaults", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          zalouser: {
            dmPolicy: "disabled",
            accounts: {
              work: {
                dmPolicy: "allowlist",
              },
            },
          },
        },
      }),
      channelKey: "zalouser",
    });

    const channel = channelRecord(next, "zalouser");
    const work = accountRecord(channel, "work");
    expect(work.dmPolicy).toBe("allowlist");
    expect(next.channels?.zalouser?.dmPolicy).toBeUndefined();
  });
});

describe("createEnvPatchedAccountSetupAdapter", () => {
  it("rejects env mode for named accounts and requires credentials otherwise", () => {
    const adapter = createEnvPatchedAccountSetupAdapter({
      channelKey: "demo-env",
      defaultAccountOnlyEnvError: "env only on default",
      missingCredentialError: "token required",
      hasCredentials: (input) => Boolean(input.token || input.tokenFile),
      buildPatch: (input) => ({ token: input.token }),
    });

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: "work",
        input: { useEnv: true },
      }),
    ).toBe("env only on default");

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      }),
    ).toBe("token required");

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: { token: "tok" },
      }),
    ).toBeNull();
  });
});
