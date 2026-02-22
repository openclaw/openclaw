import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";

const promptAccountIdSdkMock = vi.hoisted(() => vi.fn(async () => "default"));
vi.mock("../../../plugin-sdk/onboarding.js", () => ({
  promptAccountId: promptAccountIdSdkMock,
}));

import {
  normalizeAllowFromEntries,
  promptResolvedAllowFrom,
  resolveAccountIdForConfigure,
  resolveOnboardingAccountId,
  setAccountAllowFromForChannel,
  setChannelDmPolicyWithAllowFrom,
  splitOnboardingEntries,
} from "./helpers.js";

function createPrompter(inputs: string[]) {
  return {
    text: vi.fn(async () => inputs.shift() ?? ""),
    note: vi.fn(async () => undefined),
  };
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
      parseInputs: (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
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

    const result = await promptResolvedAllowFrom({
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      existing: [],
      token: "xoxb-test",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      parseId: () => null,
      invalidWithoutTokenNote: "ids only",
      resolveEntries,
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

    const result = await promptResolvedAllowFrom({
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      existing: [],
      token: "xoxb-test",
      message: "msg",
      placeholder: "placeholder",
      label: "allowlist",
      parseInputs: (value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      parseId: () => null,
      invalidWithoutTokenNote: "ids only",
      resolveEntries,
    });

    expect(result).toEqual(["U234"]);
    expect(prompter.note).toHaveBeenCalledWith(
      "Failed to resolve usernames. Try again.",
      "allowlist",
    );
    expect(resolveEntries).toHaveBeenCalledTimes(2);
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
});

describe("splitOnboardingEntries", () => {
  it("splits comma/newline/semicolon input and trims blanks", () => {
    expect(splitOnboardingEntries(" alice, bob \ncarol;  ;\n")).toEqual(["alice", "bob", "carol"]);
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
