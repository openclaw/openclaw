import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
  patchScopedAccountConfig,
} from "./setup-helpers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function config(channel: string, section: Record<string, unknown>): OpenClawConfig {
  return asConfig({ channels: { [channel]: section } });
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

afterAll(resetPluginRuntimeStateForTest);

it("patchScopedAccountConfig clears only default-account credentials before replacement", () => {
  const next = patchScopedAccountConfig({
    cfg: config("demo-setup", {
      enabled: false,
      token: "old-token",
      tokenFile: "/old/token",
      webhookPath: "/keep",
    }),
    channelKey: "demo-setup",
    accountId: DEFAULT_ACCOUNT_ID,
    clearFields: ["token", "tokenFile"],
    patch: { token: "new-token" },
    ensureChannelEnabled: false,
  });

  expect(next.channels?.["demo-setup"]).toEqual({
    enabled: false,
    token: "new-token",
    webhookPath: "/keep",
  });
});

describe("createPatchedAccountSetupAdapter", () => {
  const tokenAdapter = createPatchedAccountSetupAdapter({
    channelKey: "demo-setup",
    buildPatch: (input) => ({ botToken: input.token }),
  });

  it("migrates base name into the default account before patching a named account", () => {
    const next = tokenAdapter.applyAccountConfig({
      cfg: config("demo-setup", { name: "Personal", accounts: { work: { botToken: "old" } } }),
      accountId: "Work Team",
      input: { name: "Work", token: "new" },
    });

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        work: { botToken: "old" },
        "work-team": { enabled: true, name: "Work", botToken: "new" },
      },
    });
    expect(next.channels?.["demo-setup"]).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-accounts",
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
    });

    const next = adapter.applyAccountConfig({
      cfg: config("demo-accounts", {}),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Phone", authDir: "/tmp/auth" },
    });

    expect(next.channels?.["demo-accounts"]).toMatchObject({
      accounts: { default: { enabled: true, name: "Phone", authDir: "/tmp/auth" } },
    });
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
    const credentials = {
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "token",
    };
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config("matrix", { ...credentials, accounts: { main: { enabled: true } } }),
      channelKey: "matrix",
      setupSurface: {
        applyAccountConfig: ({ cfg }) => cfg,
        singleAccountKeysToMove: ["homeserver", "userId", "accessToken"],
        namedAccountPromotionKeys: ["accessToken", "homeserver", "userId"],
        resolveSingleAccountPromotionTarget: () => "main",
      },
    });
    expect(next.channels?.matrix).toEqual({
      accounts: { main: { enabled: true, ...credentials } },
    });
  });

  it("preserves explicit named-account values over promoted root defaults", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: config("zalouser", {
        dmPolicy: "disabled",
        accounts: { work: { dmPolicy: "allowlist" } },
      }),
      channelKey: "zalouser",
    });

    expect(next.channels?.zalouser?.accounts?.work?.dmPolicy).toBe("allowlist");
    expect(next.channels?.zalouser?.dmPolicy).toBeUndefined();
  });
});

it("createEnvPatchedAccountSetupAdapter rejects named-account env mode and requires credentials", () => {
  const adapter = createEnvPatchedAccountSetupAdapter({
    channelKey: "demo-env",
    defaultAccountOnlyEnvError: "env only on default",
    missingCredentialError: "token required",
    hasCredentials: (input) => Boolean(input.token || input.tokenFile),
    buildPatch: (input) => ({ token: input.token }),
  });

  const validate = (
    accountId: string,
    input: Parameters<NonNullable<typeof adapter.validateInput>>[0]["input"],
  ) => adapter.validateInput?.({ cfg: {}, accountId, input });
  expect(validate("work", { useEnv: true })).toBe("env only on default");
  expect(validate(DEFAULT_ACCOUNT_ID, {})).toBe("token required");
  expect(validate(DEFAULT_ACCOUNT_ID, { token: "tok" })).toBeNull();
});
