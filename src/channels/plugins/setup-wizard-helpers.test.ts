// Setup wizard helper tests cover channel setup step formatting and config writes.
import { expectDefined } from "@openclaw/normalization-core";
import {
  resolveSetupWizardAllowFromEntries,
  resolveSetupWizardGroupAllowlist,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  buildSingleChannelSecretPromptState,
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowFromSection,
  createPromptParsedAllowFromForAccount,
  createStandardChannelSetupStatus,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelGroupPolicySetter,
  createTopLevelChannelParsedAllowFromPrompt,
  normalizeAllowFromEntries,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  parseSetupEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  patchTopLevelChannelConfigSection,
  promptParsedAllowFromForAccount,
  parseSetupEntriesWithParser,
  promptSingleChannelSecretInput,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  setAccountAllowFromForChannel,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setSetupChannelEnabled,
} from "./setup-wizard-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

const matrixSingleAccountKeysToMove = [
  "allowBots",
  "deviceId",
  "deviceName",
  "dm",
  "encryption",
  "groups",
  "rooms",
] as const;
const matrixNamedAccountPromotionKeys = [
  "accessToken",
  "deviceId",
  "deviceName",
  "encryption",
  "homeserver",
  "userId",
] as const;
const telegramSingleAccountKeysToMove = ["streaming", "webhookSecret"] as const;
const telegramSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: telegramSingleAccountKeysToMove,
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

function createPrompter(inputs: string[]) {
  const text = vi.fn(async () => inputs.shift() ?? "");
  const note = vi.fn(async () => undefined);
  return {
    ...createWizardPrompter(),
    text,
    note,
  };
}

function parseCsvInputs(value: string): string[] {
  const entries: string[] = [];
  for (const part of value.split(",")) {
    const entry = part.trim();
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

type AllowFromResolver = (params: {
  token: string;
  entries: string[];
}) => Promise<Array<{ input: string; resolved: boolean; id?: string | null }>>;
function asAllowFromResolver(resolveEntries: ReturnType<typeof vi.fn>): AllowFromResolver {
  return resolveEntries as AllowFromResolver;
}

async function runPromptResolvedAllowFromWithToken(params: {
  prompter: ReturnType<typeof createPrompter>;
  resolveEntries: AllowFromResolver;
}) {
  return await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: [],
    token: "xoxb-test",
    message: "msg",
    placeholder: "placeholder",
    label: "allowlist",
    parseInputs: parseCsvInputs,
    parseId: () => null,
    invalidWithoutTokenNote: "ids only",
    resolveEntries: params.resolveEntries,
  });
}

function createSecretInputPrompter(params: {
  selects: string[];
  confirms?: boolean[];
  texts?: string[];
}) {
  const selects = [...params.selects];
  const confirms = [...(params.confirms ?? [])];
  const texts = [...(params.texts ?? [])];
  const confirm = vi.fn(async () => confirms.shift() ?? false);
  const text = vi.fn(async () => texts.shift() ?? "");
  const note = vi.fn(async () => undefined);
  const prompter = createWizardPrompter(undefined, {
    defaultSelect: "plaintext",
    selectValues: selects,
  });
  return {
    ...prompter,
    select: vi.mocked(prompter.select),
    confirm,
    text,
    note,
  };
}

async function runPromptSingleChannelSecretInput(params: {
  prompter: ReturnType<typeof createSecretInputPrompter>;
  providerHint: string;
  credentialLabel: string;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
  preferredEnvVar: string;
}) {
  return await promptSingleChannelSecretInput({
    cfg: {},
    prompter: params.prompter,
    providerHint: params.providerHint,
    credentialLabel: params.credentialLabel,
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    hasConfigToken: params.hasConfigToken,
    envPrompt: "use env",
    keepPrompt: "keep",
    inputPrompt: "token",
    preferredEnvVar: params.preferredEnvVar,
  });
}

describe("buildSingleChannelSecretPromptState", () => {
  it.each([
    {
      name: "enables env path only when env is present and no config token exists",
      input: {
        accountConfigured: false,
        hasConfigToken: false,
        allowEnv: true,
        envValue: "token-from-env",
      },
      expected: {
        accountConfigured: false,
        hasConfigToken: false,
        canUseEnv: true,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(buildSingleChannelSecretPromptState(input)).toEqual(expected);
  });
});

describe("promptResolvedAllowFrom", () => {
  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      prompter,
      existing: ["111"],
      token: "",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: parseCsvInputs,
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      invalidWithoutTokenNote: "ids only",
      resolveEntries: resolveEntries as Parameters<
        typeof promptResolvedAllowFrom
      >[0]["resolveEntries"],
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
    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });
    expect(result).toEqual([id]);
    expect(prompter.note).toHaveBeenCalledWith(note, "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
});

describe("promptSingleChannelSecretInput", () => {
  it.each([
    {
      name: "plaintext env fallback",
      selects: ["plaintext"],
      confirms: [true],
      providerHint: "telegram",
      credentialLabel: "Telegram bot token",
      accountConfigured: false,
      canUseEnv: true,
      hasConfigToken: false,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      expected: { action: "use-env" },
    },
    {
      name: "external env reference",
      selects: ["ref", "env"],
      texts: ["OPENCLAW_TEST_TOKEN"],
      providerHint: "discord",
      credentialLabel: "Discord bot token",
      accountConfigured: false,
      canUseEnv: false,
      hasConfigToken: false,
      preferredEnvVar: "OPENCLAW_TEST_TOKEN",
      expected: {
        action: "set",
        value: { source: "env", provider: "default", id: "OPENCLAW_TEST_TOKEN" },
        resolvedValue: "secret-token",
      },
    },
    {
      name: "existing configured reference",
      selects: ["ref"],
      confirms: [true],
      providerHint: "telegram",
      credentialLabel: "Telegram bot token",
      accountConfigured: true,
      canUseEnv: false,
      hasConfigToken: true,
      preferredEnvVar: "TELEGRAM_BOT_TOKEN",
      expected: { action: "keep" },
    },
  ])("selects $name", async ({ expected, name: _name, ...params }) => {
    if (expected.action === "set") {
      vi.stubEnv("OPENCLAW_TEST_TOKEN", "secret-token");
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
    }
    const prompter = createSecretInputPrompter(params);
    const result = await runPromptSingleChannelSecretInput({ ...params, prompter });
    expect(result).toEqual(expected);
    if (expected.action === "keep") {
      expect(prompter.text).not.toHaveBeenCalled();
    }
  });
});

describe("promptParsedAllowFromForAccount", () => {
  it("can merge parsed values with existing entries", async () => {
    const next = await promptParsedAllowFromForAccount({
      cfg: {
        channels: {
          nostr: {
            allowFrom: ["old"],
          },
        },
      } as OpenClawConfig,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter: createPrompter(["new"]),
      noteTitle: "Nostr allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      getExistingAllowFrom: ({ cfg }) => [...(cfg.channels?.nostr?.allowFrom ?? [])],
      mergeEntries: ({ existing, parsed }) => [...existing.map(String), ...parsed],
      applyAllowFrom: ({ cfg, allowFrom }) =>
        patchTopLevelChannelConfigSection({
          cfg,
          channel: "nostr",
          patch: { allowFrom },
        }),
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["old", "new"]);
  });
});

describe("createPromptParsedAllowFromForAccount", () => {
  it("supports computed default account ids and optional notes", async () => {
    const promptAllowFrom = createPromptParsedAllowFromForAccount<OpenClawConfig>({
      defaultAccountId: () => "work",
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        parseSetupEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      getExistingAllowFrom: ({ cfg, accountId }) => [
        ...((
          cfg.channels?.imessage?.accounts?.[accountId] as
            | { allowFrom?: ReadonlyArray<string | number> }
            | undefined
        )?.allowFrom ?? []),
      ],
      applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "imessage",
          accountId,
          patch: { allowFrom },
        }),
    });

    const prompter = createPrompter(["Alice, ALICE"]);
    const next = await promptAllowFrom({
      cfg: {
        channels: {
          imessage: {
            accounts: {
              work: {
                allowFrom: ["old"],
              },
            },
          },
        },
      },
      prompter,
    });

    expect(
      (
        next.channels?.imessage?.accounts?.work as
          | { allowFrom?: ReadonlyArray<string | number> }
          | undefined
      )?.allowFrom,
    ).toEqual(["alice"]);
    expect(prompter.note).not.toHaveBeenCalled();
  });
});

describe("parsed allowFrom prompt builders", () => {
  it("builds a top-level parsed allowFrom prompt", async () => {
    const promptAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
      channel: "nostr",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      noteTitle: "Nostr allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim().toLowerCase()] }),
    });

    const prompter = createPrompter(["npub1"]);
    const next = await promptAllowFrom({
      cfg: {},
      prompter,
    });

    expect(next.channels?.nostr?.allowFrom).toEqual(["npub1"]);
    expect(prompter.note).toHaveBeenCalledWith("line", "Nostr allowlist");
  });
});

describe("channel lookup note helpers", () => {
  it("emits summary lines for resolved and unresolved entries", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
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
});

describe("setAccountAllowFromForChannel", () => {
  it("writes allowFrom on nested non-default account config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          enabled: true,
          allowFrom: ["default-old"],
          accounts: {
            alt: { enabled: true, account: "+15555550123", allowFrom: ["alt-old"] },
          },
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      cfg,
      channel: "signal",
      accountId: "alt",
      allowFrom: ["alt-new"],
    });

    expect(next.channels?.signal?.allowFrom).toEqual(["default-old"]);
    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["alt-new"]);
    expect(next.channels?.signal?.accounts?.alt?.account).toBe("+15555550123");
  });
});

describe("patchChannelConfigForAccount", () => {
  it.each([
    {
      name: "plugin-owned root",
      channel: "demo",
      accountId: "ada",
      section: { name: "Root", groupPolicy: "allowlist", groupAllowFrom: [] },
      patch: { groupPolicy: "disabled" },
      setupSurface: {
        configPromotion: "preserve-root",
        applyAccountConfig: ({ cfg }) => cfg,
      },
      expected: {
        name: "Root",
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        enabled: true,
        accounts: { ada: { enabled: true, groupPolicy: "disabled" } },
      },
    },
    {
      name: "disabled named account",
      channel: "slack",
      accountId: "work",
      section: { enabled: true, accounts: { work: { enabled: false, botToken: "old-bot" } } },
      patch: { botToken: "new-bot", appToken: "new-app" },
      expected: {
        enabled: true,
        accounts: { work: { enabled: false, botToken: "new-bot", appToken: "new-app" } },
      },
    },
    {
      name: "single-account promotion",
      channel: "telegram",
      accountId: "work",
      section: {
        enabled: true,
        botToken: "legacy-token",
        allowFrom: ["100"],
        groupPolicy: "allowlist",
        streaming: { mode: "partial" },
        webhookSecret: "legacy-webhook-secret",
      },
      patch: { botToken: "work-token" },
      setupSurface: telegramSetupSurface,
      expected: {
        enabled: true,
        accounts: {
          default: {
            botToken: "legacy-token",
            allowFrom: ["100"],
            groupPolicy: "allowlist",
            streaming: { mode: "partial" },
            webhookSecret: "legacy-webhook-secret",
          },
          work: { enabled: true, botToken: "work-token" },
        },
      },
    },
  ] satisfies Array<{
    name: string;
    channel: string;
    accountId: string;
    section: Record<string, unknown>;
    patch: Record<string, unknown>;
    setupSurface?: ChannelSetupAdapter;
    expected: Record<string, unknown>;
  }>)(
    "patches $name without losing existing config",
    ({ channel, accountId, section, patch, setupSurface, expected }) => {
      const cfg: OpenClawConfig = { channels: { [channel]: section } };
      const next = patchChannelConfigForAccount({ cfg, channel, accountId, patch, setupSurface });
      expect(next.channels?.[channel]).toEqual(expected);
      expect(cfg.channels?.[channel]).toEqual(section);
    },
  );
});

describe("setSetupChannelEnabled", () => {
  it("updates enabled and keeps existing channel fields", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
    };

    const next = setSetupChannelEnabled(cfg, "discord", false);
    expect(next.channels?.discord?.enabled).toBe(false);
    expect(next.channels?.discord?.token).toBe("abc");
  });
});

describe("setTopLevelChannelDmPolicyWithAllowFrom", () => {
  it("supports custom allowFrom lookup callback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: ["alice"],
        },
      },
    };

    const next = setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "nextcloud-talk",
      dmPolicy: "open",
      getAllowFrom: (inputCfg) =>
        normalizeAllowFromEntries([...(inputCfg.channels?.["nextcloud-talk"]?.allowFrom ?? [])]),
    });
    expect(next.channels?.["nextcloud-talk"]?.allowFrom).toEqual(["alice", "*"]);
  });
});

describe("patchTopLevelChannelConfigSection", () => {
  it("clears requested fields before applying a patch", () => {
    const next = patchTopLevelChannelConfigSection({
      cfg: {
        channels: {
          nostr: {
            privateKey: "nsec1",
            relays: ["wss://old.example"],
          },
        },
      },
      channel: "nostr",
      clearFields: ["privateKey"],
      patch: { relays: ["wss://new.example"] },
      enabled: true,
    });

    expect(next.channels?.nostr?.privateKey).toBeUndefined();
    expect(next.channels?.nostr?.relays).toEqual(["wss://new.example"]);
    expect(next.channels?.nostr?.enabled).toBe(true);
  });
});

describe("createTopLevelChannelDmPolicy", () => {
  it("creates a reusable dm policy definition", () => {
    const dmPolicy = createTopLevelChannelDmPolicy({
      label: "LINE",
      channel: "line",
      policyKey: "channels.line.dmPolicy",
      allowFromKey: "channels.line.allowFrom",
      getCurrent: (cfg) =>
        (cfg.channels?.line?.dmPolicy as
          | "open"
          | "pairing"
          | "allowlist"
          | "disabled"
          | undefined) ?? "pairing",
    });

    const next = dmPolicy.setPolicy(
      {
        channels: {
          line: {
            dmPolicy: "pairing",
            allowFrom: ["U123"],
          },
        },
      },
      "open",
    );

    expect(dmPolicy.getCurrent({})).toBe("pairing");
    expect(next.channels?.line?.dmPolicy).toBe("open");
    expect(next.channels?.line?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("createTopLevelChannelGroupPolicySetter", () => {
  it("reuses the shared top-level groupPolicy writer", () => {
    const setGroupPolicy = createTopLevelChannelGroupPolicySetter({
      channel: "feishu",
      enabled: true,
    });
    const next = setGroupPolicy({}, "allowlist");

    expect(next.channels?.feishu?.groupPolicy).toBe("allowlist");
    expect(next.channels?.feishu?.enabled).toBe(true);
  });
});

describe("createAccountScopedAllowFromSection", () => {
  it("builds an account-scoped allowFrom section with shared apply wiring", async () => {
    const section = createAccountScopedAllowFromSection({
      channel: "discord",
      credentialInputKey: "token",
      message: "Discord allowFrom",
      placeholder: "@alice",
      invalidWithoutCredentialNote: "need ids",
      parseId: (value) => value.trim() || null,
      resolveEntries: async ({ entries }) =>
        entries.map((input) => ({ input, resolved: true, id: input.toUpperCase() })),
    });

    expect(section.credentialInputKey).toBe("token");
    await expect(
      resolveSetupWizardAllowFromEntries({
        resolveEntries: section.resolveEntries,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["alice"],
      }),
    ).resolves.toEqual([{ input: "alice", resolved: true, id: "ALICE" }]);

    const next = await section.apply({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["123"],
    });

    expect(next.channels?.discord?.dmPolicy).toBe("allowlist");
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
  });
});

describe("createAllowFromSection", () => {
  it("builds a parsed allowFrom section with default local resolution", async () => {
    const section = createAllowFromSection({
      helpTitle: "LINE allowlist",
      helpLines: ["line"],
      credentialInputKey: "token",
      message: "LINE allowFrom",
      placeholder: "U123",
      invalidWithoutCredentialNote: "need ids",
      parseId: (value) => value.trim().toUpperCase() || null,
      apply: ({ cfg, accountId, allowFrom }) =>
        patchChannelConfigForAccount({
          cfg,
          channel: "line",
          accountId,
          patch: { dmPolicy: "allowlist", allowFrom },
        }),
    });

    expect(section.helpTitle).toBe("LINE allowlist");
    await expect(
      resolveSetupWizardAllowFromEntries({
        resolveEntries: section.resolveEntries,
        accountId: DEFAULT_ACCOUNT_ID,
        entries: ["u1"],
      }),
    ).resolves.toEqual([{ input: "u1", resolved: true, id: "U1" }]);

    const next = await section.apply({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["U1"],
    });
    expect(next.channels?.line?.allowFrom).toEqual(["U1"]);
  });
});

describe("createAccountScopedGroupAccessSection", () => {
  it("builds group access with shared setPolicy and fallback lookup notes", async () => {
    const prompter = createPrompter([]);
    const section = createAccountScopedGroupAccessSection({
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
        patchChannelConfigForAccount({
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
});

describe("parseSetupEntriesAllowingWildcard", () => {
  it.each([
    { input: " *,\n Foo;  ;\n", expected: { entries: ["*", "foo"] } },
    { input: "ok,bad", expected: { entries: [], error: "bad entry" } },
  ])("parses wildcard-aware entries $input", ({ input, expected }) => {
    expect(
      parseSetupEntriesAllowingWildcard(input, (entry) =>
        entry === "bad" ? { error: "bad entry" } : { value: entry.toLowerCase() },
      ),
    ).toEqual(expected);
  });
});

describe("resolveEntriesWithOptionalToken", () => {
  it.each([
    {
      token: undefined,
      entries: ["alice", "bob"],
      expected: [
        { input: "alice", resolved: false, id: null },
        { input: "bob", resolved: false, id: null },
      ],
    },
    {
      token: "xoxb-test",
      entries: ["alice"],
      expected: [{ input: "alice", resolved: true, id: "xoxb-test:alice" }],
    },
  ])("resolves entries with token $token", async ({ token, entries, expected }) => {
    const resolveEntries = vi.fn(
      async ({ token: resolvedToken, entries: inputs }: { token: string; entries: string[] }) =>
        inputs.map((input) => ({ input, resolved: true, id: `${resolvedToken}:${input}` })),
    );
    if (!token) {
      resolveEntries.mockRejectedValue(new Error("should not run"));
    }
    await expect(
      resolveEntriesWithOptionalToken<{ input: string; resolved: boolean; id: string | null }>({
        token,
        entries,
        buildWithoutToken: (input) => ({ input, resolved: false, id: null }),
        resolveEntries,
      }),
    ).resolves.toEqual(expected);
    expect(resolveEntries).toHaveBeenCalledTimes(token ? 1 : 0);
  });
});

describe("parseMentionOrPrefixedId", () => {
  it.each([
    { value: "<@!123>", expected: "123" },
    { value: "slack:u123abc", expected: "U123ABC", normalize: true },
    { value: "   ", expected: null },
    { value: "@alice", expected: null },
  ])("parses mention or prefixed id $value", ({ value, expected, normalize }) => {
    expect(
      parseMentionOrPrefixedId({
        value,
        mentionPattern: normalize ? /^<@([A-Z0-9]+)>$/i : /^<@!?(\d+)>$/,
        prefixPattern: normalize ? /^(slack:|user:)/i : /^(user:|discord:)/i,
        idPattern: normalize ? /^[A-Z][A-Z0-9]+$/i : /^\d+$/,
        ...(normalize ? { normalizeId: (id: string) => id.toUpperCase() } : {}),
      }),
    ).toBe(expected);
  });
});

describe("normalizeAllowFromEntries", () => {
  it("normalizes values, preserves wildcard, and removes duplicates", () => {
    expect(
      normalizeAllowFromEntries([" +15555550123 ", "*", "+15555550123", "bad"], (value) =>
        value.startsWith("+1") ? value : null,
      ),
    ).toEqual(["+15555550123", "*"]);
  });
});

describe("createStandardChannelSetupStatus", () => {
  it.each([false, true])("builds setup status with status lines=%s", async (includeStatusLine) => {
    const status = createStandardChannelSetupStatus({
      channelLabel: "Demo",
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      ...(includeStatusLine
        ? {
            includeStatusLine: true,
            resolveExtraStatusLines: ({ configured }: { configured: boolean }) => [
              `Configured: ${configured ? "yes" : "no"}`,
            ],
          }
        : {
            configuredHint: "ready",
            unconfiguredHint: "missing token",
            configuredScore: 2,
            unconfiguredScore: 0,
          }),
      resolveConfigured: ({ cfg }) => Boolean(cfg.channels?.demo),
    });
    if (includeStatusLine) {
      expect(
        await status.resolveStatusLines?.({ cfg: { channels: { demo: {} } }, configured: true }),
      ).toEqual(["Demo: configured", "Configured: yes"]);
    } else {
      expect(status).toMatchObject({
        configuredHint: "ready",
        unconfiguredHint: "missing token",
        configuredScore: 2,
        unconfiguredScore: 0,
      });
      expect(await status.resolveConfigured({ cfg: { channels: { demo: {} } } })).toBe(true);
      expect(status.resolveStatusLines).toBeUndefined();
    }
  });
});

describe("resolveSetupAccountId", () => {
  it("normalizes provided account ids", () => {
    expect(
      resolveSetupAccountId({
        accountId: " Work Account ",
        defaultAccountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBe("work-account");
  });
});

describe("resolveAccountIdForConfigure", () => {
  it.each([
    { accountOverride: " Team Primary ", expected: "team-primary" },
    { accountOverride: undefined, expected: "prompted-id" },
  ])("resolves account with override $accountOverride", async ({ accountOverride, expected }) => {
    const prompter = createWizardPrompter(undefined, { defaultSelect: "prompted-id" });
    const accountId = await resolveAccountIdForConfigure({
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
