import {
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import * as setup from "./setup-wizard-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

const telegramSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: ["streaming", "webhookSecret"],
} as ChannelSetupAdapter;
const legacyTelegram = {
  botToken: "legacy-token",
  allowFrom: ["100"],
  groupPolicy: "allowlist",
  streaming: { mode: "partial" },
  webhookSecret: "legacy-webhook-secret",
};

beforeEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

afterAll(() => {
  resetPluginRuntimeStateForTest();
});

function parseCsvInputs(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const allowFromDefaults = {
  existing: [],
  token: "xoxb-test",
  message: "msg",
  placeholder: "placeholder",
  label: "allowlist",
  parseInputs: parseCsvInputs,
  parseId: () => null,
  invalidWithoutTokenNote: "ids only",
};
const parsedPromptDefaults = {
  defaultAccountId: DEFAULT_ACCOUNT_ID,
  message: "msg",
  placeholder: "placeholder",
  noteTitle: "Nostr allowlist",
  noteLines: ["line"],
  parseEntries: (raw: string) => ({ entries: [raw.trim().toLowerCase()] }),
};
const sectionDefaults = {
  credentialInputKey: "token",
  message: "allowFrom",
  placeholder: "user-id",
  invalidWithoutCredentialNote: "need ids",
};

function createPrompter(
  inputs: string[],
  options: { selects?: string[]; confirms?: boolean[] } = {},
) {
  const confirms = [...(options.confirms ?? [])];
  const texts = [...inputs];
  return createWizardPrompter(
    {
      confirm: vi.fn(async () => confirms.shift() ?? false),
      text: vi.fn(async () => texts.shift() ?? ""),
    },
    { defaultSelect: options.selects ? "plaintext" : undefined, selectValues: options.selects },
  );
}

const secretDefaults = {
  cfg: {},
  providerHint: "telegram",
  credentialLabel: "Bot token",
  preferredEnvVar: "TELEGRAM_BOT_TOKEN",
  envPrompt: "use env",
  keepPrompt: "keep",
  inputPrompt: "token",
};

describe("setup wizard helpers", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await setup.promptResolvedAllowFrom({
      ...allowFromDefaults,
      prompter,
      existing: ["111"],
      token: "",
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      resolveEntries,
    });

    expect(result).toEqual(["111", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("ids only", "allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it.each([
    { failure: "unresolved", note: "Could not resolve: alice", id: "U123" },
    { failure: "throw", note: "Failed to resolve usernames. Try again.", id: "U234" },
  ])("re-prompts after $failure resolution before succeeding", async ({ failure, note, id }) => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi.fn();
    if (failure === "throw") {
      resolveEntries.mockRejectedValueOnce(new Error("network"));
    } else {
      resolveEntries.mockResolvedValueOnce([{ input: "alice", resolved: false }]);
    }
    resolveEntries.mockResolvedValueOnce([{ input: "bob", resolved: true, id }]);
    const result = await setup.promptResolvedAllowFrom({
      ...allowFromDefaults,
      prompter,
      resolveEntries,
    });
    expect(result).toEqual([id]);
    expect(prompter.note).toHaveBeenCalledWith(note, "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
  it.each(["use-env", "set"] as const)("selects %s", async (action) => {
    const expected =
      action === "set"
        ? {
            action,
            value: { source: "env", provider: "default", id: "OPENCLAW_TEST_TOKEN" },
            resolvedValue: "secret-token",
          }
        : { action };
    if (expected.action === "set") {
      vi.stubEnv("OPENCLAW_TEST_TOKEN", "secret-token");
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
    }
    const prompter = createPrompter(action === "set" ? ["OPENCLAW_TEST_TOKEN"] : [], {
      selects: action === "use-env" ? ["plaintext"] : ["ref", "env"],
      confirms: [true],
    });
    const state = setup.buildSingleChannelSecretPromptState({
      accountConfigured: false,
      hasConfigToken: false,
      allowEnv: action === "use-env",
      envValue: "token-from-env",
    });
    expect(state).toEqual({
      accountConfigured: false,
      hasConfigToken: false,
      canUseEnv: action === "use-env",
    });
    const result = await setup.promptSingleChannelSecretInput({
      ...secretDefaults,
      ...state,
      prompter,
      ...(action === "set" ? { preferredEnvVar: "OPENCLAW_TEST_TOKEN" } : {}),
    });
    expect(result).toEqual(expected);
  });
  it.each([false, true])("merges top-level allowFrom with notes=%s", async (notes) => {
    const prompt = setup.createTopLevelChannelParsedAllowFromPrompt({
      ...parsedPromptDefaults,
      channel: "nostr",
      ...(!notes ? { noteTitle: undefined, noteLines: undefined } : {}),
      mergeEntries: ({ existing, parsed }) => [...existing.map(String), ...parsed],
    });
    const prompter = createPrompter(["new"]);
    const next = await prompt({ cfg: { channels: { nostr: { allowFrom: ["old"] } } }, prompter });
    expect(next.channels?.nostr?.allowFrom).toEqual(["old", "new"]);
    if (notes) {
      expect(prompter.note).toHaveBeenCalledWith("line", "Nostr allowlist");
    } else {
      expect(prompter.note).not.toHaveBeenCalled();
    }
  });
  it("emits summary lines for resolved and unresolved entries", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await setup.noteChannelLookupSummary({
      prompter,
      label: "Slack channels",
      resolvedSections: [
        { title: "Resolved", values: ["C1", "C2"] },
        { title: "Resolved guilds", values: [] },
      ],
      unresolved: ["#typed-name"],
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Resolved: C1, C2\nUnresolved (kept as typed): #typed-name",
      "Slack channels",
    );
  });
  it.each([false, true])("patches accounts with promotion=%s without losing config", (promote) => {
    const channel = promote ? "telegram" : "slack";
    const section = promote
      ? { enabled: true, ...legacyTelegram }
      : { enabled: true, accounts: { work: { enabled: false, botToken: "old-bot" } } };
    const expected = {
      enabled: true,
      accounts: promote
        ? {
            default: structuredClone(legacyTelegram),
            work: { enabled: true, botToken: "work-token" },
          }
        : { work: { enabled: false, botToken: "new-bot", appToken: "new-app" } },
    };
    const cfg: OpenClawConfig = { channels: { [channel]: section } };
    const next = setup.patchChannelConfigForAccount({
      cfg,
      channel,
      accountId: "work",
      patch: promote ? { botToken: "work-token" } : { botToken: "new-bot", appToken: "new-app" },
      setupSurface: promote ? telegramSetupSurface : undefined,
    });
    expect(next.channels?.[channel]).toEqual(expected);
    expect(cfg.channels?.[channel]).toEqual(section);
  });
  it("updates enabled and keeps existing channel fields", () => {
    const cfg: OpenClawConfig = { channels: { discord: { enabled: true, token: "abc" } } };

    const next = setup.setSetupChannelEnabled(cfg, "discord", false);
    expect(next.channels?.discord).toMatchObject({ enabled: false, token: "abc" });
  });
  it("clears requested fields before applying a patch", () => {
    const next = setup.patchTopLevelChannelConfigSection({
      cfg: { channels: { nostr: { privateKey: "nsec1", relays: ["wss://old.example"] } } },
      channel: "nostr",
      clearFields: ["privateKey"],
      patch: { relays: ["wss://new.example"] },
      enabled: true,
    });

    expect(next.channels?.nostr).toEqual({ relays: ["wss://new.example"], enabled: true });
  });
  it("creates a reusable dm policy definition", () => {
    const dmPolicy = setup.createTopLevelChannelDmPolicy({
      label: "LINE",
      channel: "line",
      policyKey: "channels.line.dmPolicy",
      allowFromKey: "channels.line.allowFrom",
      getAllowFrom: (cfg) => setup.normalizeAllowFromEntries(cfg.channels?.line?.allowFrom ?? []),
      getCurrent: (cfg) => cfg.channels?.line?.dmPolicy ?? "pairing",
    });

    const next = dmPolicy.setPolicy(
      { channels: { line: { dmPolicy: "pairing", allowFrom: ["U123"] } } },
      "open",
    );

    expect(dmPolicy.getCurrent({})).toBe("pairing");
    expect(next.channels?.line).toMatchObject({ dmPolicy: "open", allowFrom: ["U123", "*"] });
  });
  it("reuses the shared top-level groupPolicy writer", () => {
    const setGroupPolicy = setup.createTopLevelChannelGroupPolicySetter({
      channel: "feishu",
      enabled: true,
    });
    expect(setGroupPolicy({}, "allowlist").channels?.feishu).toMatchObject({
      groupPolicy: "allowlist",
      enabled: true,
    });
  });
  it.each([false, true])("builds allowFrom with local resolution=%s", async (local) => {
    const options = {
      ...sectionDefaults,
      parseId: (value: string) => value.trim().toUpperCase() || null,
    };
    const section = local
      ? setup.createAllowFromSection({
          ...options,
          helpTitle: "LINE allowlist",
          helpLines: ["line"],
          apply: ({ cfg, accountId, allowFrom }) =>
            setup.patchChannelConfigForAccount({
              cfg,
              channel: "line",
              accountId,
              patch: { dmPolicy: "allowlist", allowFrom },
            }),
        })
      : setup.createAccountScopedAllowFromSection({
          ...options,
          channel: "line",
          resolveEntries: async ({ entries }) =>
            entries.map((input) => ({
              input,
              resolved: true,
              id: input.toUpperCase(),
            })),
        });
    if (local) {
      expect(section.helpTitle).toBe("LINE allowlist");
    } else {
      expect(section.credentialInputKey).toBe("token");
    }
    await expect(
      resolveSetupWizardAllowFromEntries({
        resolveEntries: section.resolveEntries,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["u1"],
      }),
    ).resolves.toEqual([{ input: "u1", resolved: true, id: "U1" }]);
    const next = await section.apply({ cfg: {}, accountId: DEFAULT_ACCOUNT_ID, allowFrom: ["U1"] });
    expect(next.channels?.line).toMatchObject({ dmPolicy: "allowlist", allowFrom: ["U1"] });
  });
  it("builds group access with shared setPolicy and fallback lookup notes", async () => {
    const prompter = createPrompter([]);
    const section = setup.createAccountScopedGroupAccessSection({
      channel: "slack",
      label: "Slack channels",
      placeholder: "#general",
      currentPolicy: () => "allowlist",
      currentEntries: () => [],
      updatePrompt: () => false,
      resolveAllowlist: async () => {
        throw new Error("boom");
      },
      fallbackResolved: (entries) => entries,
      applyAllowlist: ({ cfg, resolved, accountId }) =>
        setup.patchChannelConfigForAccount({
          cfg,
          channel: "slack",
          accountId,
          patch: {
            channels: Object.fromEntries(resolved.map((entry) => [entry, { allow: true }])),
          },
        }),
    });

    const policyNext = section.setPolicy({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      policy: "open",
    });
    expect(policyNext.channels?.slack?.groupPolicy).toBe("open");

    await expect(
      resolveSetupWizardGroupAllowlist({
        resolveAllowlist: section.resolveAllowlist,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["general"],
        prompter,
      }),
    ).resolves.toEqual(["general"]);
    expect(prompter.note).toHaveBeenCalledTimes(2);
    expect(prompter.note).toHaveBeenCalledWith(
      "Channel lookup failed; keeping entries as typed. Error: boom",
      "Slack channels",
    );

    const allowlistNext = section.applyAllowlist?.({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      resolved: ["C123"],
    });
    expect(allowlistNext?.channels?.slack?.channels).toEqual({
      C123: { allow: true },
    });
  });
  it.each([
    { input: " *,\n Foo; foo; ;\n", expected: { entries: ["*", "foo"] } },
    { input: "ok,bad", expected: { entries: [], error: "bad entry" } },
  ])("parses wildcard-aware entries $input", ({ input, expected }) => {
    expect(
      setup.parseSetupEntriesAllowingWildcard(input, (entry) =>
        entry === "bad" ? { error: "bad entry" } : { value: entry.toLowerCase() },
      ),
    ).toEqual(expected);
  });
  it.each([undefined, "xoxb-test"])("resolves entries with token %s", async (token) => {
    const entries = ["alice", "bob"];
    const resolveEntries = vi.fn(
      async ({ token: resolvedToken, entries: inputs }: { token: string; entries: string[] }) =>
        inputs.map((input) => `${resolvedToken}:${input}`),
    );
    if (!token) {
      resolveEntries.mockRejectedValue(new Error("should not run"));
    }
    await expect(
      setup.resolveEntriesWithOptionalToken({
        token,
        entries,
        buildWithoutToken: (input) => `unresolved:${input}`,
        resolveEntries,
      }),
    ).resolves.toEqual(
      token ? ["xoxb-test:alice", "xoxb-test:bob"] : ["unresolved:alice", "unresolved:bob"],
    );
    expect(resolveEntries).toHaveBeenCalledTimes(token ? 1 : 0);
  });
  it.each([
    { value: "<@!123>", expected: "123" },
    { value: "slack:u123abc", expected: "U123ABC", normalize: true },
    { value: "   ", expected: null },
    { value: "@alice", expected: null },
  ])("parses mention or prefixed id $value", ({ value, expected, normalize }) => {
    expect(
      setup.parseMentionOrPrefixedId({
        value,
        mentionPattern: normalize ? /^<@([A-Z0-9]+)>$/i : /^<@!?(\d+)>$/,
        prefixPattern: normalize ? /^(slack:|user:)/i : /^(user:|discord:)/i,
        idPattern: normalize ? /^[A-Z][A-Z0-9]+$/i : /^\d+$/,
        ...(normalize ? { normalizeId: (id: string) => id.toUpperCase() } : {}),
      }),
    ).toBe(expected);
  });
  it("normalizes values, preserves wildcard, and removes duplicates", () => {
    expect(
      setup.normalizeAllowFromEntries([" +15555550123 ", "*", "+15555550123", "bad"], (value) =>
        value.startsWith("+1") ? value : null,
      ),
    ).toEqual(["+15555550123", "*"]);
  });
  it("combines standard and extra status lines", async () => {
    const status = setup.createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      includeStatusLine: true,
      resolveExtraStatusLines: ({ configured }) => [`Configured: ${configured ? "yes" : "no"}`],
      resolveConfigured: () => true,
    });
    expect(await status.resolveStatusLines?.({ cfg: {}, configured: true })).toEqual([
      "Demo: configured",
      "Configured: yes",
    ]);
  });
  it.each([
    { accountOverride: " Team Primary ", expected: "team-primary" },
    { accountOverride: undefined, expected: "prompted-id" },
  ])("resolves account with override $accountOverride", async ({ accountOverride, expected }) => {
    const prompter = createWizardPrompter(undefined, { defaultSelect: "prompted-id" });
    const accountId = await setup.resolveAccountIdForConfigure({
      cfg: {},
      prompter,
      label: "Signal",
      accountOverride,
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", expected],
      defaultAccountId: "fallback",
    });
    expect(accountId).toBe(expected);
    if (!accountOverride) {
      expect(prompter.select).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Signal account",
          initialValue: "fallback",
        }),
      );
      expect(prompter.text).not.toHaveBeenCalled();
    }
  });
});
