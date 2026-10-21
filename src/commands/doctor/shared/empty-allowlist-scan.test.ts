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

describe("doctor empty allowlist policy scan", () => {
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

  it("allows provider-specific extra warnings without importing providers", async () => {
    const warnings = await scan(
      { telegram: { groupPolicy: "allowlist" } },
      {
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
    const warnings = await scan(
      {
        "legacy-channel": {
          allowFrom: [],
          accounts: { work: { dm: { policy: "allowlist", allowFrom: ["nested-sender"] } } },
        },
      },
      {
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

    const warnings = await scan(
      {
        telegram: {
          enabled: false,
          dmPolicy: "allowlist",
          accounts: { default: { dmPolicy: "allowlist" } },
        },
        signal: { accounts: { disabled: { enabled: false, dmPolicy: "allowlist" } } },
      },
      { extraWarningsForAccount },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
    expect(extraWarningsForAccount).toHaveBeenCalledTimes(1);
    const [warningOptions] = extraWarningsForAccount.mock.calls[0] ?? [];
    expect(warningOptions?.prefix).toBe("channels.signal");
  });
});
