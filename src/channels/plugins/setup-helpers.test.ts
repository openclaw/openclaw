import { afterAll, beforeEach, expect, it } from "vitest";
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

function config(channel: string, section: Record<string, unknown>): OpenClawConfig {
  return { channels: { [channel]: section } } as OpenClawConfig;
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

it.each([
  [
    "named-account promotion",
    false,
    "Work Team",
    { name: "Personal", accounts: { work: { botToken: "old" } } },
    {
      enabled: true,
      accounts: {
        default: { name: "Personal" },
        work: { botToken: "old" },
        "work-team": { enabled: true, name: "Work", botToken: "new" },
      },
    },
  ],
  [
    "default in accounts.default",
    true,
    DEFAULT_ACCOUNT_ID,
    {},
    { accounts: { default: { enabled: true, name: "Work", botToken: "new" } } },
  ],
] as const)("patches %s", (_name, alwaysUseAccounts, accountId, section, expected) => {
  const next = createPatchedAccountSetupAdapter({
    channelKey: "demo-setup",
    alwaysUseAccounts,
    buildPatch: (input) => ({ botToken: input.token }),
  }).applyAccountConfig({
    cfg: config("demo-setup", section),
    accountId,
    input: { name: "Work", token: "new" },
  });
  expect(next.channels?.["demo-setup"]).toEqual(expected);
});

it("does not add a default when an ordinary named account already exists and no keys move", () => {
  const cfg = config("demo", { enabled: true, accounts: { ada: {} } });
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

  expect(next.channels?.zalouser).toEqual({ accounts: { work: { dmPolicy: "allowlist" } } });
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
