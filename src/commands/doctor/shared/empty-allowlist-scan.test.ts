import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

// mock-isolation: Synthetic channel capabilities keep policy scanning independent of plugin loading.
vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
  resolveDoctorChannelAccountIds: (
    channelName: string,
    cfg: { channels?: Record<string, { accounts?: Record<string, unknown> }> },
    configuredAccountIds: string[],
  ) => {
    const resolveAccountId = (accountId: string) =>
      channelName === "matrix" || channelName === "signal" ? accountId.toLowerCase() : accountId;
    return {
      configured: configuredAccountIds.map(resolveAccountId),
      runtime: Object.keys(cfg.channels?.[channelName]?.accounts ?? {}).map(resolveAccountId),
    };
  },
}));

function scan(
  channels: OpenClawConfig["channels"],
  hooks: Omit<Parameters<typeof scanEmptyAllowlistPolicyWarnings>[1], "doctorFixCommand"> = {},
) {
  return scanEmptyAllowlistPolicyWarnings(
    { channels },
    { doctorFixCommand: "openclaw doctor --fix", ...hooks },
  );
}

async function scanWithContexts(channels: OpenClawConfig["channels"]) {
  const contexts: unknown[] = [];
  const warnings = await scan(channels, {
    extraWarningsForAccount: ({ prefix, dmPolicy, effectiveAllowFrom }) => {
      contexts.push({ prefix, dmPolicy, effectiveAllowFrom });
      return [];
    },
  });
  return { warnings, contexts };
}

describe("doctor empty allowlist policy scan", () => {
  it("projects malformed selected fields without falling through to inherited hook values", async () => {
    const { warnings, contexts } = await scanWithContexts({
      "legacy-channel": {
        dmPolicy: "allowlist",
        allowFrom: ["parent"],
        accounts: {
          work: {
            dmPolicy: 42,
            allowFrom: "not-a-list",
            dm: { policy: "allowlist", allowFrom: ["nested"] },
          },
        },
      },
    });

    expect(warnings).toEqual([]);
    expect(contexts).toEqual([
      {
        prefix: "channels.legacy-channel",
        dmPolicy: "allowlist",
        effectiveAllowFrom: ["parent"],
      },
      {
        prefix: "channels.legacy-channel.accounts.work",
        dmPolicy: undefined,
        effectiveAllowFrom: undefined,
      },
    ]);
  });

  it.each([
    {
      channelName: "imessage",
      skip: false,
      expected: [
        '- channels.imessage.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to channels.imessage.groupAllowFrom, or set groupPolicy to "open".',
      ],
    },
    { channelName: "zalouser", skip: true, expected: [] },
    { channelName: "discord", skip: false, expected: [] },
    {
      channelName: "telegram",
      skip: false,
      expected: [
        '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      ],
    },
  ])(
    "retains $channelName group warnings and subsequent plugin warnings",
    async ({ channelName, skip, expected }) => {
      expect(
        await scan(
          { [channelName]: { groupPolicy: "allowlist" } },
          {
            shouldSkipDefaultEmptyGroupAllowlistWarning: () => skip,
            extraWarningsForAccount: ({ prefix }) => [`extra:${prefix}`],
          },
        ),
      ).toStrictEqual([...expected, `extra:channels.${channelName}`]);
    },
  );

  it("does not warn on empty parent groupAllowFrom when active accounts have effective group allowlists", async () => {
    const warnings = await scan({
      telegram: {
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        accounts: {
          primary: { groupAllowFrom: ["telegram:group:primary"] },
          backup: { allowFrom: ["telegram:group:backup"] },
        },
      },
    });

    expect(warnings).toEqual([]);
  });

  it("keeps inherited top-level allowlists ahead of nested account values in warnings and hooks", async () => {
    const { warnings, contexts } = await scanWithContexts({
      "legacy-channel": {
        allowFrom: [],
        accounts: { work: { dm: { policy: "allowlist", allowFrom: ["nested-sender"] } } },
      },
    });

    expect(warnings).toEqual([
      '- channels.legacy-channel.accounts.work.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.legacy-channel.accounts.work.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
    expect(contexts).toContainEqual({
      dmPolicy: "allowlist",
      effectiveAllowFrom: [],
      prefix: "channels.legacy-channel.accounts.work",
    });
  });

  it("skips disabled channel and account entries", async () => {
    const warnings = await scan(
      {
        telegram: {
          enabled: false,
          dmPolicy: "allowlist",
          accounts: { default: { dmPolicy: "allowlist" } },
        },
        signal: { accounts: { disabled: { enabled: false, dmPolicy: "allowlist" } } },
      },
      { extraWarningsForAccount: ({ prefix }) => [`extra:${prefix}`] },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
  });
});
