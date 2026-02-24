import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";

const promptAccountIdSdkMock = vi.hoisted(() => vi.fn(async () => "default"));
vi.mock("../../../plugin-sdk/onboarding.js", () => ({
  promptAccountId: promptAccountIdSdkMock,
}));

import {
  applySingleTokenPromptResult,
  normalizeAllowFromEntries,
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  parseMentionOrPrefixedId,
  parseOnboardingEntriesAllowingWildcard,
  patchChannelConfigForAccount,
  patchLegacyDmChannelConfig,
  promptLegacyChannelAllowFrom,
  parseOnboardingEntriesWithParser,
  promptParsedAllowFromForScopedChannel,
  promptSingleChannelToken,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveOnboardingAccountId,
  setAccountAllowFromForChannel,
  setAccountGroupPolicyForChannel,
  setChannelDmPolicyWithAllowFrom,
  setLegacyChannelAllowFrom,
  setLegacyChannelDmPolicyWithAllowFrom,
  setOnboardingChannelEnabled,
  splitOnboardingEntries,
} from "./helpers.js";

function createPrompter(inputs: string[]) {
  return {
    text: vi.fn(async () => inputs.shift() ?? ""),
    note: vi.fn(async () => undefined),
  };
}

function createTokenPrompter(params: { confirms: boolean[]; texts: string[] }) {
  const confirms = [...params.confirms];
  const texts = [...params.texts];
  return {
    confirm: vi.fn(async () => confirms.shift() ?? true),
    text: vi.fn(async () => texts.shift() ?? ""),
  };
}

function parseCsvInputs(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
    // oxlint-disable-next-line typescript/no-explicit-any
    prompter: params.prompter as any,
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

async function runPromptSingleToken(params: {
  prompter: ReturnType<typeof createTokenPrompter>;
  accountConfigured: boolean;
  canUseEnv: boolean;
  hasConfigToken: boolean;
}) {
  return await promptSingleChannelToken({
    prompter: params.prompter,
    accountConfigured: params.accountConfigured,
    canUseEnv: params.canUseEnv,
    hasConfigToken: params.hasConfigToken,
    envPrompt: "use env",
    keepPrompt: "keep",
    inputPrompt: "token",
  });
}

async function runPromptLegacyAllowFrom(params: {
  cfg?: OpenClawConfig;
  channel: "discord" | "slack";
  prompter: ReturnType<typeof createPrompter>;
  existing: string[];
  token: string;
  noteTitle: string;
  noteLines: string[];
  parseId: (value: string) => string | null;
  resolveEntries: AllowFromResolver;
}) {
  return await promptLegacyChannelAllowFrom({
    cfg: params.cfg ?? {},
    channel: params.channel,
    // oxlint-disable-next-line typescript/no-explicit-any
    prompter: params.prompter as any,
    existing: params.existing,
    token: params.token,
    noteTitle: params.noteTitle,
    noteLines: params.noteLines,
    message: "msg",
    placeholder: "placeholder",
    parseId: params.parseId,
    invalidWithoutTokenNote: "ids only",
    resolveEntries: params.resolveEntries,
  });
}

describe("promptResolvedAllowFrom", () => {
  beforeEach(() => {
    promptAccountIdSdkMock.mockReset();
    promptAccountIdSdkMock.mockResolvedValue("default");
  });

  it("re-prompts without token until all ids are parseable", async () => {
    const prompter = createPrompter(["@alice", "123"]);
    const resolveEntries = vi.fn();

    const result = await promptResolvedAllowFrom({
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      existing: ["111"],
      token: "",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: parseCsvInputs,
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      invalidWithoutTokenNote: "ids only",
      // oxlint-disable-next-line typescript/no-explicit-any
      resolveEntries: resolveEntries as any,
    });

    expect(result).toEqual(["111", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("ids only", "allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("re-prompts when token resolution returns unresolved entries", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockResolvedValueOnce([{ input: "alice", resolved: false }])
      .mockResolvedValueOnce([{ input: "bob", resolved: true, id: "U123" }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U123"]);
    expect(prompter.note).toHaveBeenCalledWith("Could not resolve: alice", "allowlist");
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });

  it("re-prompts when resolver throws before succeeding", async () => {
    const prompter = createPrompter(["alice", "bob"]);
    const resolveEntries = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([{ input: "bob", resolved: true, id: "U234" }]);

    const result = await runPromptResolvedAllowFromWithToken({
      prompter,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(result).toEqual(["U234"]);
    expect(prompter.note).toHaveBeenCalledWith(
      "Failed to resolve usernames. Try again.",
      "allowlist",
    );
    expect(resolveEntries).toHaveBeenCalledTimes(2);
  });
});

describe("promptLegacyChannelAllowFrom", () => {
  it("applies parsed ids without token resolution", async () => {
    const prompter = createPrompter([" 123 "]);
    const resolveEntries = vi.fn();

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "discord",
      existing: ["999"],
      prompter,
      token: "",
      noteTitle: "Discord allowlist",
      noteLines: ["line1", "line2"],
      parseId: (value) => (/^\d+$/.test(value.trim()) ? value.trim() : null),
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(next.channels?.discord?.allowFrom).toEqual(["999", "123"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "Discord allowlist");
    expect(resolveEntries).not.toHaveBeenCalled();
  });

  it("uses resolver when token is present", async () => {
    const prompter = createPrompter(["alice"]);
    const resolveEntries = vi.fn(async () => [{ input: "alice", resolved: true, id: "U1" }]);

    const next = await runPromptLegacyAllowFrom({
      cfg: {} as OpenClawConfig,
      channel: "slack",
      prompter,
      existing: [],
      token: "xoxb-token",
      noteTitle: "Slack allowlist",
      noteLines: ["line"],
      parseId: () => null,
      resolveEntries: asAllowFromResolver(resolveEntries),
    });

    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
    expect(resolveEntries).toHaveBeenCalledWith({ token: "xoxb-token", entries: ["alice"] });
  });
});

describe("promptSingleChannelToken", () => {
  it("uses env tokens when confirmed", async () => {
    const prompter = createTokenPrompter({ confirms: [true], texts: [] });
    const result = await runPromptSingleToken({
      prompter,
      accountConfigured: false,
      canUseEnv: true,
      hasConfigToken: false,
    });
    expect(result).toEqual({ useEnv: true, token: null });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("prompts for token when env exists but user declines env", async () => {
    const prompter = createTokenPrompter({ confirms: [false], texts: ["abc"] });
    const result = await runPromptSingleToken({
      prompter,
      accountConfigured: false,
      canUseEnv: true,
      hasConfigToken: false,
    });
    expect(result).toEqual({ useEnv: false, token: "abc" });
  });

  it("keeps existing configured token when confirmed", async () => {
    const prompter = createTokenPrompter({ confirms: [true], texts: [] });
    const result = await runPromptSingleToken({
      prompter,
      accountConfigured: true,
      canUseEnv: false,
      hasConfigToken: true,
    });
    expect(result).toEqual({ useEnv: false, token: null });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("prompts for token when no env/config token is used", async () => {
    const prompter = createTokenPrompter({ confirms: [false], texts: ["xyz"] });
    const result = await runPromptSingleToken({
      prompter,
      accountConfigured: true,
      canUseEnv: false,
      hasConfigToken: false,
    });
    expect(result).toEqual({ useEnv: false, token: "xyz" });
  });
});

describe("applySingleTokenPromptResult", () => {
  it("writes env selection as an empty patch on target account", () => {
    const next = applySingleTokenPromptResult({
      cfg: {},
      channel: "discord",
      accountId: "work",
      tokenPatchKey: "token",
      tokenResult: { useEnv: true, token: null },
    });

    expect(next.channels?.discord?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.enabled).toBe(true);
    expect(next.channels?.discord?.accounts?.work?.token).toBeUndefined();
  });

  it("writes provided token under requested key", () => {
    const next = applySingleTokenPromptResult({
      cfg: {},
      channel: "telegram",
      accountId: DEFAULT_ACCOUNT_ID,
      tokenPatchKey: "botToken",
      tokenResult: { useEnv: false, token: "abc" },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("abc");
  });
});

describe("promptParsedAllowFromForScopedChannel", () => {
  it("writes parsed allowFrom values to default account channel config", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          allowFrom: ["old"],
        },
      },
    };
    const prompter = createPrompter([" Alice, ALICE "]);

    const next = await promptParsedAllowFromForScopedChannel({
      cfg,
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "iMessage allowlist",
      noteLines: ["line1", "line2"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        parseOnboardingEntriesWithParser(raw, (entry) => ({ value: entry.toLowerCase() })),
      getExistingAllowFrom: ({ cfg }) => cfg.channels?.imessage?.allowFrom ?? [],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["alice"]);
    expect(prompter.note).toHaveBeenCalledWith("line1\nline2", "iMessage allowlist");
  });

  it("writes parsed values to non-default account allowFrom", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            alt: {
              allowFrom: ["+15555550123"],
            },
          },
        },
      },
    };
    const prompter = createPrompter(["+15555550124"]);

    const next = await promptParsedAllowFromForScopedChannel({
      cfg,
      channel: "signal",
      accountId: "alt",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "Signal allowlist",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) => ({ entries: [raw.trim()] }),
      getExistingAllowFrom: ({ cfg, accountId }) =>
        cfg.channels?.signal?.accounts?.[accountId]?.allowFrom ?? [],
    });

    expect(next.channels?.signal?.accounts?.alt?.allowFrom).toEqual(["+15555550124"]);
    expect(next.channels?.signal?.allowFrom).toBeUndefined();
  });

  it("uses parser validation from the prompt validate callback", async () => {
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async (params: { validate?: (value: string) => string | undefined }) => {
        expect(params.validate?.("")).toBe("Required");
        expect(params.validate?.("bad")).toBe("bad entry");
        expect(params.validate?.("ok")).toBeUndefined();
        return "ok";
      }),
    };

    const next = await promptParsedAllowFromForScopedChannel({
      cfg: {},
      channel: "imessage",
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      prompter,
      noteTitle: "title",
      noteLines: ["line"],
      message: "msg",
      placeholder: "placeholder",
      parseEntries: (raw) =>
        raw.trim() === "bad"
          ? { entries: [], error: "bad entry" }
          : { entries: [raw.trim().toLowerCase()] },
      getExistingAllowFrom: () => [],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["ok"]);
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

  it("skips note output when there is nothing to report", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupSummary({
      prompter,
      label: "Discord channels",
      resolvedSections: [{ title: "Resolved", values: [] }],
      unresolved: [],
    });
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("formats lookup failures consistently", async () => {
    const prompter = { note: vi.fn(async () => undefined) };
    await noteChannelLookupFailure({
      prompter,
      label: "Discord channels",
      error: new Error("boom"),
    });
    expect(prompter.note).toHaveBeenCalledWith(
      "Channel lookup failed; keeping entries as typed. Error: boom",
      "Discord channels",
    );
  });
});

describe("setAccountAllowFromForChannel", () => {
  it("writes allowFrom on default account channel config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          enabled: true,
          allowFrom: ["old"],
          accounts: {
            work: { allowFrom: ["work-old"] },
          },
        },
      },
    };

    const next = setAccountAllowFromForChannel({
      cfg,
      channel: "imessage",
      accountId: DEFAULT_ACCOUNT_ID,
      allowFrom: ["new-default"],
    });

    expect(next.channels?.imessage?.allowFrom).toEqual(["new-default"]);
    expect(next.channels?.imessage?.accounts?.work?.allowFrom).toEqual(["work-old"]);
  });

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
  it("patches root channel config for default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: false,
          botToken: "old",
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "telegram",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { botToken: "new", dmPolicy: "allowlist" },
    });

    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.botToken).toBe("new");
    expect(next.channels?.telegram?.dmPolicy).toBe("allowlist");
  });

  it("patches nested account config and preserves existing enabled flag", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          enabled: true,
          accounts: {
            work: {
              enabled: false,
              botToken: "old-bot",
            },
          },
        },
      },
    };

    const next = patchChannelConfigForAccount({
      cfg,
      channel: "slack",
      accountId: "work",
      patch: { botToken: "new-bot", appToken: "new-app" },
    });

    expect(next.channels?.slack?.enabled).toBe(true);
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(false);
    expect(next.channels?.slack?.accounts?.work?.botToken).toBe("new-bot");
    expect(next.channels?.slack?.accounts?.work?.appToken).toBe("new-app");
  });

  it("supports imessage/signal account-scoped channel patches", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          enabled: false,
          accounts: {},
        },
        imessage: {
          enabled: false,
        },
      },
    };

    const signalNext = patchChannelConfigForAccount({
      cfg,
      channel: "signal",
      accountId: "work",
      patch: { account: "+15555550123", cliPath: "signal-cli" },
    });
    expect(signalNext.channels?.signal?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.enabled).toBe(true);
    expect(signalNext.channels?.signal?.accounts?.work?.account).toBe("+15555550123");

    const imessageNext = patchChannelConfigForAccount({
      cfg: signalNext,
      channel: "imessage",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { cliPath: "imsg" },
    });
    expect(imessageNext.channels?.imessage?.enabled).toBe(true);
    expect(imessageNext.channels?.imessage?.cliPath).toBe("imsg");
  });
});

describe("setOnboardingChannelEnabled", () => {
  it("updates enabled and keeps existing channel fields", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "abc",
        },
      },
    };

    const next = setOnboardingChannelEnabled(cfg, "discord", false);
    expect(next.channels?.discord?.enabled).toBe(false);
    expect(next.channels?.discord?.token).toBe("abc");
  });

  it("creates missing channel config with enabled state", () => {
    const next = setOnboardingChannelEnabled({}, "signal", true);
    expect(next.channels?.signal?.enabled).toBe(true);
  });
});

describe("patchLegacyDmChannelConfig", () => {
  it("patches discord root config and defaults dm.enabled to true", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dmPolicy: "pairing",
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "discord",
      patch: { allowFrom: ["123"] },
    });
    expect(next.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(true);
  });

  it("preserves explicit dm.enabled=false for slack", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          dm: {
            enabled: false,
          },
        },
      },
    };

    const next = patchLegacyDmChannelConfig({
      cfg,
      channel: "slack",
      patch: { dmPolicy: "open" },
    });
    expect(next.channels?.slack?.dmPolicy).toBe("open");
    expect(next.channels?.slack?.dm?.enabled).toBe(false);
  });
});

describe("setLegacyChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom for open policy using legacy dm allowFrom fallback", () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          dm: {
            enabled: false,
            allowFrom: ["123"],
          },
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "discord",
      dmPolicy: "open",
    });
    expect(next.channels?.discord?.dmPolicy).toBe("open");
    expect(next.channels?.discord?.allowFrom).toEqual(["123", "*"]);
    expect(next.channels?.discord?.dm?.enabled).toBe(false);
  });

  it("sets policy without changing allowFrom when not open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          allowFrom: ["U1"],
        },
      },
    };

    const next = setLegacyChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "slack",
      dmPolicy: "pairing",
    });
    expect(next.channels?.slack?.dmPolicy).toBe("pairing");
    expect(next.channels?.slack?.allowFrom).toEqual(["U1"]);
  });
});

describe("setLegacyChannelAllowFrom", () => {
  it("writes allowFrom through legacy dm patching", () => {
    const next = setLegacyChannelAllowFrom({
      cfg: {},
      channel: "slack",
      allowFrom: ["U123"],
    });
    expect(next.channels?.slack?.allowFrom).toEqual(["U123"]);
    expect(next.channels?.slack?.dm?.enabled).toBe(true);
  });
});

describe("setAccountGroupPolicyForChannel", () => {
  it("writes group policy on default account config", () => {
    const next = setAccountGroupPolicyForChannel({
      cfg: {},
      channel: "discord",
      accountId: DEFAULT_ACCOUNT_ID,
      groupPolicy: "open",
    });
    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(next.channels?.discord?.enabled).toBe(true);
  });

  it("writes group policy on nested non-default account", () => {
    const next = setAccountGroupPolicyForChannel({
      cfg: {},
      channel: "slack",
      accountId: "work",
      groupPolicy: "disabled",
    });
    expect(next.channels?.slack?.accounts?.work?.groupPolicy).toBe("disabled");
    expect(next.channels?.slack?.accounts?.work?.enabled).toBe(true);
  });
});

describe("setChannelDmPolicyWithAllowFrom", () => {
  it("adds wildcard allowFrom when setting dmPolicy=open", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          dmPolicy: "pairing",
          allowFrom: ["+15555550123"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "signal",
      dmPolicy: "open",
    });

    expect(next.channels?.signal?.dmPolicy).toBe("open");
    expect(next.channels?.signal?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("sets dmPolicy without changing allowFrom for non-open policies", () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "imessage",
      dmPolicy: "pairing",
    });

    expect(next.channels?.imessage?.dmPolicy).toBe("pairing");
    expect(next.channels?.imessage?.allowFrom).toEqual(["*"]);
  });

  it("supports telegram channel dmPolicy updates", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          dmPolicy: "pairing",
          allowFrom: ["123"],
        },
      },
    };

    const next = setChannelDmPolicyWithAllowFrom({
      cfg,
      channel: "telegram",
      dmPolicy: "open",
    });
    expect(next.channels?.telegram?.dmPolicy).toBe("open");
    expect(next.channels?.telegram?.allowFrom).toEqual(["123", "*"]);
  });
});

describe("splitOnboardingEntries", () => {
  it("splits comma/newline/semicolon input and trims blanks", () => {
    expect(splitOnboardingEntries(" alice, bob \ncarol;  ;\n")).toEqual(["alice", "bob", "carol"]);
  });
});

describe("parseOnboardingEntriesWithParser", () => {
  it("maps entries and de-duplicates parsed values", () => {
    expect(
      parseOnboardingEntriesWithParser(" alice, ALICE ; * ", (entry) => {
        if (entry === "*") {
          return { value: "*" };
        }
        return { value: entry.toLowerCase() };
      }),
    ).toEqual({
      entries: ["alice", "*"],
    });
  });

  it("returns parser errors and clears parsed entries", () => {
    expect(
      parseOnboardingEntriesWithParser("ok, bad", (entry) =>
        entry === "bad" ? { error: "invalid entry: bad" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "invalid entry: bad",
    });
  });
});

describe("parseOnboardingEntriesAllowingWildcard", () => {
  it("preserves wildcard and delegates non-wildcard entries", () => {
    expect(
      parseOnboardingEntriesAllowingWildcard(" *, Foo ", (entry) => ({
        value: entry.toLowerCase(),
      })),
    ).toEqual({
      entries: ["*", "foo"],
    });
  });

  it("returns parser errors for non-wildcard entries", () => {
    expect(
      parseOnboardingEntriesAllowingWildcard("ok,bad", (entry) =>
        entry === "bad" ? { error: "bad entry" } : { value: entry },
      ),
    ).toEqual({
      entries: [],
      error: "bad entry",
    });
  });
});

describe("parseMentionOrPrefixedId", () => {
  it("parses mention ids", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "<@!123>",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBe("123");
  });

  it("parses prefixed ids and normalizes result", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "slack:u123abc",
        mentionPattern: /^<@([A-Z0-9]+)>$/i,
        prefixPattern: /^(slack:|user:)/i,
        idPattern: /^[A-Z][A-Z0-9]+$/i,
        normalizeId: (id) => id.toUpperCase(),
      }),
    ).toBe("U123ABC");
  });

  it("returns null for blank or invalid input", () => {
    expect(
      parseMentionOrPrefixedId({
        value: "   ",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBeNull();
    expect(
      parseMentionOrPrefixedId({
        value: "@alice",
        mentionPattern: /^<@!?(\d+)>$/,
        prefixPattern: /^(user:|discord:)/i,
        idPattern: /^\d+$/,
      }),
    ).toBeNull();
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

  it("trims and de-duplicates without a normalizer", () => {
    expect(normalizeAllowFromEntries([" alice ", "bob", "alice"])).toEqual(["alice", "bob"]);
  });
});

describe("resolveOnboardingAccountId", () => {
  it("normalizes provided account ids", () => {
    expect(
      resolveOnboardingAccountId({
        accountId: " Work Account ",
        defaultAccountId: DEFAULT_ACCOUNT_ID,
      }),
    ).toBe("work-account");
  });

  it("falls back to default account id when input is blank", () => {
    expect(
      resolveOnboardingAccountId({
        accountId: "   ",
        defaultAccountId: "custom-default",
      }),
    ).toBe("custom-default");
  });
});

describe("resolveAccountIdForConfigure", () => {
  beforeEach(() => {
    promptAccountIdSdkMock.mockReset();
    promptAccountIdSdkMock.mockResolvedValue("default");
  });

  it("uses normalized override without prompting", async () => {
    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: {} as any,
      label: "Signal",
      accountOverride: " Team Primary ",
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", "team-primary"],
      defaultAccountId: DEFAULT_ACCOUNT_ID,
    });
    expect(accountId).toBe("team-primary");
  });

  it("uses default account when override is missing and prompting disabled", async () => {
    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: {} as any,
      label: "Signal",
      shouldPromptAccountIds: false,
      listAccountIds: () => ["default"],
      defaultAccountId: "fallback",
    });
    expect(accountId).toBe("fallback");
  });

  it("prompts for account id when prompting is enabled and no override is provided", async () => {
    promptAccountIdSdkMock.mockResolvedValueOnce("prompted-id");

    const accountId = await resolveAccountIdForConfigure({
      cfg: {},
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: {} as any,
      label: "Signal",
      shouldPromptAccountIds: true,
      listAccountIds: () => ["default", "prompted-id"],
      defaultAccountId: "fallback",
    });

    expect(accountId).toBe("prompted-id");
    expect(promptAccountIdSdkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Signal",
        currentId: "fallback",
        defaultAccountId: "fallback",
      }),
    );
  });
});
