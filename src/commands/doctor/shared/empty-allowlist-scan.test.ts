// Empty allowlist scan tests cover doctor detection of unconfigured sender allowlists.
import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
  resolveDoctorChannelAccountIds: (
    channelName: string,
    cfg: {
      channels?: Record<
        string,
        { accounts?: Record<string, unknown>; appId?: string; baseUrl?: string }
      >;
    },
    configuredAccountIds: string[],
  ) => {
    const channel = cfg.channels?.[channelName];
    const ids = Object.keys(channel?.accounts ?? {});
    const resolveAccountId = (accountId: string) =>
      channelName === "matrix" || channelName === "signal" ? accountId.toLowerCase() : accountId;
    const runtimeIds = [
      ...(channelName === "qa-channel" && channel?.baseUrl ? ["default"] : []),
      ...(channelName === "qqbot" && channel?.appId ? ["default"] : []),
      ...ids,
    ];
    return {
      configured: configuredAccountIds.map(resolveAccountId),
      runtime: runtimeIds.map(resolveAccountId),
    };
  },
}));

describe("doctor empty allowlist policy scan", () => {
  it("does not warn on empty parent groupAllowFrom when active accounts have effective group allowlists", async () => {
    const warnings = await scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            accounts: {
              primary: { groupAllowFrom: ["telegram:group:primary"] },
              backup: { allowFrom: ["telegram:group:backup"] },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("allows provider-specific extra warnings without importing providers", async () => {
    const warnings = await scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ channelName, prefix }) =>
          channelName === "telegram" ? [`extra:${prefix}`] : [],
      },
    );

    expect(warnings).toStrictEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      "extra:channels.telegram",
    ]);
  });

  it("keeps inherited top-level allowlists ahead of nested account values in warnings and hooks", async () => {
    const accountContexts: unknown[] = [];
    const warnings = await scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          "legacy-channel": {
            allowFrom: [],
            accounts: {
              work: { dm: { policy: "allowlist", allowFrom: ["nested-sender"] } },
            },
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ dmPolicy, effectiveAllowFrom, prefix }) => {
          accountContexts.push({ dmPolicy, effectiveAllowFrom, prefix });
          return [];
        },
      },
    );

    expect(warnings).toEqual([
      '- channels.legacy-channel.accounts.work.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.legacy-channel.accounts.work.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
    expect(accountContexts).toContainEqual({
      dmPolicy: "allowlist",
      effectiveAllowFrom: [],
      prefix: "channels.legacy-channel.accounts.work",
    });
  });

  it("skips disabled channel and account entries", async () => {
    const extraWarningsForAccount = vi.fn(({ prefix }) => [`extra:${prefix}`]);

    const warnings = await scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "allowlist",
            accounts: {
              default: { dmPolicy: "allowlist" },
            },
          },
          signal: {
            accounts: {
              disabled: { enabled: false, dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix", extraWarningsForAccount },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
    expect(extraWarningsForAccount).toHaveBeenCalledTimes(1);
    const [warningOptions] = extraWarningsForAccount.mock.calls[0] ?? [];
    expect(warningOptions?.prefix).toBe("channels.signal");
  });
});
